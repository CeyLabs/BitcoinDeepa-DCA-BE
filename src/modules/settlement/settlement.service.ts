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
      // Fetch unsettled transactions without locking (just for discovery)
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

      // Process each transaction with proper locking
      for (const transaction of unsettledTransactions) {
        await this.tryTransactionSettlement(transaction);
      }
    } catch (error) {
      await this.dbLogger.error(
        `Error during settlement retry process: ${error.message}`,
      );
    }
  }

  private async tryTransactionSettlement(transaction: any) {
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

    // CRITICAL FIX: Atomically claim this transaction using SELECT FOR UPDATE SKIP LOCKED
    // This prevents race conditions when multiple cron jobs run concurrently
    const trx = await this.knexService.knex.transaction();

    try {
      // Lock this specific transaction row, skip if already locked by another process
      const lockedTransaction = await trx('transaction')
        .where('payhere_pay_id', payhere_pay_id)
        .where('settled', false)
        .where('retry_count', retry_count) // Ensure retry_count hasn't changed
        .forUpdate()
        .skipLocked()
        .first();

      // If we couldn't acquire the lock, another process is handling this transaction
      if (!lockedTransaction) {
        await trx.rollback();
        await this.dbLogger.info(
          `Skipping transaction ${payhere_pay_id} - already being processed by another instance`,
        );
        return;
      }

      // Immediately update retry_count to prevent other processes from picking it up
      await trx('transaction')
        .update({
          retry_count: currentRetryCount,
          last_retry_at: new Date(),
        })
        .where('payhere_pay_id', payhere_pay_id);

      await this.dbLogger.info(
        `Transaction ${payhere_pay_id} locked and retry_count updated to ${currentRetryCount}`,
      );

      // Commit the lock and retry_count update immediately
      // This releases the lock but marks the transaction as "in progress" via retry_count
      await trx.commit();

      await this.dbLogger.info(
        `Retrying settlement for transaction ${payhere_pay_id} (attempt ${currentRetryCount}/5): ${satoshis_purchased} satoshis to user ${telegram_id}`,
      );

      const logMessage = await this.telegramLogger.logSettlement(
        payhere_pay_id,
        satoshis_purchased,
        telegram_id,
        currentRetryCount,
      );

      // Perform the external fund transfer (this can be slow)
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
        await this.knexService
          .knex('transaction')
          .update({ settled: true })
          .where('payhere_pay_id', payhere_pay_id);

        await this.dbLogger.info(
          `Settlement retry successful for transaction ${payhere_pay_id} on attempt ${currentRetryCount}: ${satoshis_purchased} satoshis transferred to user ${telegram_id}`,
        );

        // Send Telegram notification for successful settlement
        await this.telegramLogger.setMessageReaction(logMessage);
      } else {
        // Transfer failed - retry_count already updated, just log
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
      // Rollback if we haven't committed yet
      await trx.rollback();

      await this.dbLogger.error(
        `Settlement retry error for transaction ${payhere_pay_id}: ${error.message}`,
      );

      // Note: If the error happened after commit, retry_count is already updated
      // If it happened before commit, we'll try again on the next cron run
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
