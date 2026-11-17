import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KnexService } from '../knex/knex.service';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { PayHereService } from '../payhere/payhere.service';
import { errorMessage } from '../../common/error-message';

const MAX_SETTLEMENT_ATTEMPTS = 5;

interface UnsettledTransaction {
  payhere_pay_id: string;
  payhere_sub_id: string;
  satoshis_purchased: number;
  retry_count: number;
  telegram_id: string;
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
    private readonly telegramLogger: TelegramLoggerService,
    private readonly payHereService: PayHereService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async retryUnsettledTransactions() {
    if (!this.bitcoinDeepaService.isConfigured()) {
      return;
    }

    try {
      // Backoff is filtered in SQL: retry n waits 2^n minutes after the last
      // attempt, so rows still in backoff are never loaded (or logged).
      const unsettledTransactions: UnsettledTransaction[] =
        await this.knexService
          .knex('transaction as t')
          .select(
            't.payhere_pay_id',
            't.payhere_sub_id',
            't.satoshis_purchased',
            't.retry_count',
            'u.id as telegram_id',
          )
          .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
          .join('user as u', 's.user_id', 'u.id')
          .where('t.status', 'SUCCESS')
          .where('t.settled', false)
          .whereNotNull('t.satoshis_purchased')
          .whereNotNull('t.btc_price_at_purchase')
          .where('t.retry_count', '<', MAX_SETTLEMENT_ATTEMPTS)
          .where((qb) => {
            void qb
              .whereNull('t.last_retry_at')
              .orWhereRaw(
                "t.last_retry_at + (power(2, t.retry_count) * interval '1 minute') <= now()",
              );
          });

      for (const transaction of unsettledTransactions) {
        await this.tryTransactionSettlement(transaction);
      }
    } catch (error) {
      this.logger.error(
        `Error during settlement retry process: ${errorMessage(error)}`,
      );
    }
  }

  private async tryTransactionSettlement(transaction: UnsettledTransaction) {
    const {
      payhere_pay_id,
      payhere_sub_id,
      telegram_id,
      satoshis_purchased,
      retry_count = 0,
    } = transaction;
    const currentRetryCount = retry_count + 1;

    // Atomically claim the row (FOR UPDATE SKIP LOCKED + retry_count check)
    // so concurrent instances don't send the same transfer twice.
    const trx = await this.knexService.knex.transaction();
    try {
      const locked = await trx('transaction')
        .where('payhere_pay_id', payhere_pay_id)
        .where('settled', false)
        .where('status', 'SUCCESS')
        .where('retry_count', retry_count)
        .forUpdate()
        .skipLocked()
        .first();

      if (!locked) {
        await trx.rollback();
        return;
      }

      await trx('transaction')
        .update({ retry_count: currentRetryCount, last_retry_at: new Date() })
        .where('payhere_pay_id', payhere_pay_id);
      await trx.commit();
    } catch (error) {
      if (!trx.isCompleted()) {
        await trx.rollback().catch(() => undefined);
      }
      this.logger.error(
        `Failed to claim transaction ${payhere_pay_id} for settlement: ${errorMessage(error)}`,
      );
      return;
    }

    let confirmed: boolean;
    try {
      confirmed = await this.isConfirmedByPayHere(
        payhere_pay_id,
        payhere_sub_id,
      );
    } catch (error) {
      // PayHere's API failing says nothing about this payment, so it must not
      // use up settlement attempts (an outage would otherwise flag every
      // payment in it as forged). Give the attempt back; last_retry_at keeps
      // the backoff, so it is retried later.
      await this.knexService
        .knex('transaction')
        .update({ retry_count: retry_count })
        .where('payhere_pay_id', payhere_pay_id)
        .where('retry_count', currentRetryCount);
      this.logger.warn(
        `Settlement of ${payhere_pay_id} postponed: PayHere payment lookup failed (${errorMessage(error)})`,
      );
      return;
    }

    try {
      if (!confirmed) {
        const message = `payment ${payhere_pay_id} is not listed as RECEIVED by PayHere for subscription ${payhere_sub_id}`;
        if (currentRetryCount >= MAX_SETTLEMENT_ATTEMPTS) {
          const alert = `Settlement of ${payhere_pay_id} (${satoshis_purchased} sats to user ${telegram_id}) stopped: ${message}. Possibly a forged/replayed notification - check the PayHere dashboard.`;
          this.logger.error(alert);
          await this.telegramLogger.logAlert('Settlement', alert);
        } else {
          // PayHere's list can lag the notification; retry with backoff.
          this.logger.warn(
            `Settlement of ${payhere_pay_id} deferred (attempt ${currentRetryCount}/${MAX_SETTLEMENT_ATTEMPTS}): ${message}`,
          );
        }
        return;
      }

      const logMessage = await this.telegramLogger.logSettlement(
        payhere_pay_id,
        Number(satoshis_purchased),
        telegram_id,
        currentRetryCount,
      );

      const memo = await this.generateTransferMemo(
        payhere_pay_id,
        payhere_sub_id,
      );
      const result = await this.bitcoinDeepaService.transferFunds(
        satoshis_purchased,
        telegram_id,
        memo,
      );

      if (result.success || result.already_completed) {
        await this.knexService
          .knex('transaction')
          .update({ settled: true })
          .where('payhere_pay_id', payhere_pay_id);
        this.logger.log(
          result.already_completed
            ? `Settlement for ${payhere_pay_id} was already completed in a previous attempt`
            : `Settled ${payhere_pay_id}: ${satoshis_purchased} sats to user ${telegram_id} (attempt ${currentRetryCount})`,
        );
        await this.telegramLogger.setMessageReaction(logMessage);
        return;
      }

      if (result.outcome_unknown) {
        // The request may have gone through (e.g. timeout). Retrying could pay
        // twice, so stop retrying and ask a human to check.
        await this.knexService
          .knex('transaction')
          .update({ retry_count: MAX_SETTLEMENT_ATTEMPTS })
          .where('payhere_pay_id', payhere_pay_id);
        const alert = `Settlement of ${payhere_pay_id} (${satoshis_purchased} sats to user ${telegram_id}) has an UNKNOWN outcome: ${result.message}. Retries stopped - check BitcoinDeepa before resetting.`;
        this.logger.error(alert);
        await this.telegramLogger.logAlert('Settlement', alert);
        return;
      }

      if (currentRetryCount >= MAX_SETTLEMENT_ATTEMPTS) {
        const alert = `Settlement of ${payhere_pay_id} permanently failed after ${currentRetryCount} attempts: ${result.message}`;
        this.logger.error(alert);
        await this.telegramLogger.logAlert('Settlement', alert);
      } else {
        this.logger.warn(
          `Settlement of ${payhere_pay_id} failed (attempt ${currentRetryCount}/${MAX_SETTLEMENT_ATTEMPTS}): ${result.message}. Next retry in ${Math.pow(2, currentRetryCount)} minutes.`,
        );
      }
    } catch (error) {
      // retry_count is already incremented, so the backoff still applies
      this.logger.error(
        `Settlement error for ${payhere_pay_id}: ${errorMessage(error)}`,
      );
      if (currentRetryCount >= MAX_SETTLEMENT_ATTEMPTS) {
        await this.telegramLogger
          .logAlert(
            'Settlement',
            `Settlement of ${payhere_pay_id} stopped after ${currentRetryCount} attempts: ${errorMessage(error)}`,
          )
          .catch(() => undefined);
      }
    }
  }

  /**
   * Only pay out payments PayHere itself lists as received. The webhook's
   * md5sig doesn't cover payment_id, so a signed notification can be replayed
   * with invented payment_ids - this is the check that stops those being
   * paid. API errors throw (the caller retries without using an attempt).
   */
  private async isConfirmedByPayHere(
    payhere_pay_id: string,
    payhere_sub_id: string,
  ): Promise<boolean> {
    const payments =
      await this.payHereService.getSubscriptionPayments(payhere_sub_id);
    return payments.some(
      (p) => p.payment_id === String(payhere_pay_id) && p.status === 'RECEIVED',
    );
  }

  /**
   * Generate memo for fund transfer with package name
   */
  private async generateTransferMemo(
    payhere_pay_id: string,
    subscription_id: string,
  ): Promise<string> {
    let memo = `DCA Purchase (Ref: ${payhere_pay_id})`;

    try {
      const subscriptionWithPackage = await this.knexService
        .knex('subscription as s')
        .select('p.name as package_name')
        .join('package as p', 's.package_id', 'p.id')
        .where('s.payhere_sub_id', subscription_id)
        .first();

      if (subscriptionWithPackage?.package_name) {
        memo = `${subscriptionWithPackage.package_name} DCA plan (Ref: ${payhere_pay_id})`;
      }
    } catch (packageError) {
      this.logger.warn(
        `Could not fetch package name for subscription ${subscription_id}: ${errorMessage(packageError)}`,
      );
    }

    return memo;
  }
}
