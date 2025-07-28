import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KnexService } from '../knex/knex.service';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';

@Injectable()
export class SettlementService {
  constructor(
    private readonly knexService: KnexService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
    private readonly dbLogger: DatabaseLoggerService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async retryUnsettledTransactions() {
    if (!this.bitcoinDeepaService.isConfigured()) {
      await this.dbLogger.warn(
        'BitcoinDeepa service not configured - skipping settlement retry',
      );
      return;
    }

    try {
      const unsettledTransactions = await this.knexService
        .knex('transaction as t')
        .select(
          't.payhere_pay_id',
          't.payhere_sub_id',
          't.satoshis_purchased',
          't.btc_price_at_purchase',
          't.price_currency',
          't.coingecko_timestamp',
          't.retry_count',
          't.last_retry_at',
          'u.id as telegram_id',
        )
        .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
        .join('user as u', 's.user_id', 'u.id')
        .where('t.status', 'SUCCESS')
        .where('t.settled', false)
        .whereNotNull('t.satoshis_purchased')
        .whereNotNull('t.btc_price_at_purchase')
        .where('t.retry_count', '<', 5); // Max 5 retry attempts

      if (unsettledTransactions.length === 0) {
        return;
      }

      await this.dbLogger.info(
        `Found ${unsettledTransactions.length} unsettled transactions to retry`,
      );

      for (const transaction of unsettledTransactions) {
        await this.retryTransactionSettlement(transaction);
      }
    } catch (error) {
      await this.dbLogger.error(
        `Error during settlement retry process: ${error.message}`,
      );
    }
  }

  private async retryTransactionSettlement(transaction: any) {
    const {
      payhere_pay_id,
      payhere_sub_id,
      telegram_id,
      satoshis_purchased,
      retry_count = 0,
      last_retry_at,
    } = transaction;

    // Implement exponential backoff: wait 2^retry_count minutes before retry
    if (last_retry_at) {
      const backoffMinutes = Math.pow(2, retry_count);
      const nextRetryTime = new Date(
        last_retry_at.getTime() + backoffMinutes * 60 * 1000,
      );

      if (new Date() < nextRetryTime) {
        await this.dbLogger.info(
          `Skipping transaction ${payhere_pay_id} - backoff period not expired (next retry: ${nextRetryTime.toISOString()})`,
        );
        return;
      }
    }

    const currentRetryCount = retry_count + 1;
    const trx = await this.knexService.knex.transaction();

    try {
      await this.dbLogger.info(
        `Retrying settlement for transaction ${payhere_pay_id} (attempt ${currentRetryCount}/5): ${satoshis_purchased} satoshis to user ${telegram_id}`,
      );

      // First, atomically update retry count to prevent duplicate processing
      await trx('transaction')
        .update({
          retry_count: currentRetryCount,
          last_retry_at: new Date(),
        })
        .where('payhere_pay_id', payhere_pay_id);

      await this.dbLogger.info(
        `Updated retry count for transaction ${payhere_pay_id} to ${currentRetryCount}`,
      );

      // Perform the external fund transfer
      const memo = await this.generateTransferMemo(
        payhere_pay_id,
        payhere_sub_id,
      );
      const transferResult = await this.bitcoinDeepaService.transferFunds(
        satoshis_purchased,
        telegram_id,
        memo,
      );

      if (transferResult.success) {
        // Mark as settled on successful transfer
        await trx('transaction')
          .update({ settled: true })
          .where('payhere_pay_id', payhere_pay_id);

        // Commit the transaction
        await trx.commit();

        await this.dbLogger.info(
          `Settlement retry successful for transaction ${payhere_pay_id} on attempt ${currentRetryCount}: ${satoshis_purchased} satoshis transferred to user ${telegram_id}`,
        );

        // Send Telegram notification for successful settlement
        await this.telegramLogger.logSettlementSuccess(
          payhere_pay_id,
          satoshis_purchased,
          telegram_id,
          currentRetryCount,
        );
      } else {
        // Commit the retry count update even on transfer failure
        await trx.commit();

        if (currentRetryCount >= 5) {
          await this.dbLogger.error(
            `Settlement retry permanently failed for transaction ${payhere_pay_id} after ${currentRetryCount} attempts: ${transferResult.message}`,
          );
        } else {
          await this.dbLogger.warn(
            `Settlement retry failed for transaction ${payhere_pay_id} (attempt ${currentRetryCount}/5): ${transferResult.message}. Next retry in ${Math.pow(2, currentRetryCount)} minutes.`,
          );
        }
      }
    } catch (error) {
      // Rollback the transaction on any error
      await trx.rollback();

      await this.dbLogger.error(
        `Settlement retry error for transaction ${payhere_pay_id}: ${error.message}`,
      );

      // Use a separate transaction to update retry count after rollback
      try {
        await this.knexService
          .knex('transaction')
          .update({
            retry_count: currentRetryCount,
            last_retry_at: new Date(),
          })
          .where('payhere_pay_id', payhere_pay_id);

        if (currentRetryCount >= 5) {
          await this.dbLogger.error(
            `Settlement retry permanently failed for transaction ${payhere_pay_id} after ${currentRetryCount} attempts due to error: ${error.message}`,
          );
        } else {
          await this.dbLogger.error(
            `Settlement retry error for transaction ${payhere_pay_id} (attempt ${currentRetryCount}/5): ${error.message}. Next retry in ${Math.pow(2, currentRetryCount)} minutes.`,
          );
        }
      } catch (updateError) {
        await this.dbLogger.error(
          `Failed to update retry count after error for transaction ${payhere_pay_id}: ${updateError.message}`,
        );
      }
    }
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
      await this.dbLogger.warn(
        `Could not fetch package name for subscription ${subscription_id}: ${packageError.message}`,
      );
    }

    return memo;
  }
}
