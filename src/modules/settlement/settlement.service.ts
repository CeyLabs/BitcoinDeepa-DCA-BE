import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KnexService } from '../knex/knex.service';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { PayHereService } from '../payhere/payhere.service';
import { errorMessage } from '../../common/error-message';

const MAX_SETTLEMENT_ATTEMPTS = 5;
// PayHere lookup failures don't use attempts, so they need their own alert:
// once a waiting payment is this old (or at once on 401/403), at most hourly.
const LOOKUP_FAILURE_ALERT_AFTER_MS = 30 * 60_000;
const LOOKUP_FAILURE_ALERT_INTERVAL_MS = 60 * 60_000;

interface UnsettledTransaction {
  payhere_pay_id: string;
  gross_amount: string | number | null;
  payhere_sub_id: string;
  satoshis_purchased: number;
  retry_count: number;
  telegram_id: string;
  created_at: Date;
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  private lastLookupFailureAlertAt = 0;

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
            't.gross_amount',
            't.retry_count',
            't.created_at',
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
      gross_amount,
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
        gross_amount,
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
      await this.alertLookupFailure(transaction, error);
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

      const memo = SettlementService.transferMemo(payhere_pay_id);
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
   * Retrying a failed lookup forever is right for a PayHere outage, but a
   * problem that never clears (wrong app secret, missing Subscription Manager
   * permission, sandbox/live mix-up) would stop every payout silently. Alert
   * at once on 401/403, otherwise once the payment has waited a while - and
   * at most hourly, since lookups are retried every minute.
   */
  private async alertLookupFailure(
    transaction: UnsettledTransaction,
    error: unknown,
  ): Promise<void> {
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    const credentialsProblem = status === 401 || status === 403;
    const waitedMs = Date.now() - new Date(transaction.created_at).getTime();
    if (!credentialsProblem && waitedMs < LOOKUP_FAILURE_ALERT_AFTER_MS) return;
    if (
      Date.now() - this.lastLookupFailureAlertAt <
      LOOKUP_FAILURE_ALERT_INTERVAL_MS
    ) {
      return;
    }
    this.lastLookupFailureAlertAt = Date.now();

    const reason = credentialsProblem
      ? `PayHere rejected our credentials (HTTP ${status}) - check PAYHERE_APP_ID/PAYHERE_APP_SECRET, the app's Subscription Manager permission and PAYHERE_ENV`
      : `PayHere payment lookups are still failing after ${Math.round(waitedMs / 60_000)} min`;
    await this.telegramLogger
      .logAlert(
        'Settlement',
        `Payouts are paused: ${reason}. Latest error for ${transaction.payhere_pay_id}: ${errorMessage(error)}. Settlement resumes by itself once lookups succeed.`,
      )
      .catch(() => undefined);
  }

  /**
   * Only pay out payments PayHere itself lists as received. The webhook's
   * md5sig doesn't cover payment_id, so a signed notification can be replayed
   * with invented payment_ids - this is the check that stops those being
   * paid. API errors throw (the caller retries without using an attempt).
   */
  /**
   * The payment must be listed by PayHere as RECEIVED, and for the amount we
   * recorded, so the payout rests on PayHere's own figures and not only on the
   * notification. When PayHere's list omits the amount, id + status decide.
   */
  private async isConfirmedByPayHere(
    payhere_pay_id: string,
    payhere_sub_id: string,
    gross_amount: string | number | null,
  ): Promise<boolean> {
    const payments =
      await this.payHereService.getSubscriptionPayments(payhere_sub_id);
    const payment = payments.find(
      (p) => p.payment_id === String(payhere_pay_id) && p.status === 'RECEIVED',
    );
    if (!payment) return false;
    if (payment.amount === null || gross_amount === null) {
      this.logger.warn(
        `PayHere payment ${payhere_pay_id} has no amount to compare; confirmed on id and status only`,
      );
      return true;
    }
    const matches = SettlementService.sameAmount(payment.amount, gross_amount);
    if (!matches) {
      this.logger.warn(
        `PayHere payment ${payhere_pay_id} amount ${payment.amount} does not match recorded ${gross_amount}`,
      );
    }
    return matches;
  }

  private static sameAmount(a: string | number, b: string | number): boolean {
    const x = Number(String(a).replace(/,/g, ''));
    const y = Number(String(b).replace(/,/g, ''));
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.005;
  }

  /**
   * Generate memo for fund transfer with package name
   */
  /**
   * The memo is the transfer's idempotency key on the BitcoinDeepa API (a
   * repeated memo is rejected as already done), so it must be identical on
   * every attempt: built from the payment id alone, nothing that can change.
   */
  static transferMemo(payhere_pay_id: string): string {
    return `DCA purchase (Ref: ${payhere_pay_id})`;
  }
}
