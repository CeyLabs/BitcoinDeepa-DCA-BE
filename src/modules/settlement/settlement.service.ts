import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KnexService } from '../knex/knex.service';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';

@Injectable()
export class SettlementService {
  constructor(
    private readonly knexService: KnexService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
    private readonly dbLogger: DatabaseLoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async retryUnsettledTransactions() {
    if (!this.bitcoinDeepaService.isConfigured()) {
      await this.dbLogger.warn(
        'BitcoinDeepa service not configured - skipping settlement retry',
      );
      return;
    }

    try {
      const unsettledTransactions = await this.knexService.knex('transaction')
        .where('status', 'SUCCESS')
        .where('settled', false)
        .whereNotNull('satoshis_purchased')
        .whereNotNull('bitcoin_price');

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
    const { payhere_pay_id, telegram_id, satoshis_purchased } = transaction;

    try {
      await this.dbLogger.info(
        `Retrying settlement for transaction ${payhere_pay_id}: ${satoshis_purchased} satoshis to user ${telegram_id}`,
      );

      const memo = `DCA Purchase Retry - PayHere Payment ${payhere_pay_id}: ${satoshis_purchased} sats`;
      const transferResult = await this.bitcoinDeepaService.transferFunds(
        satoshis_purchased,
        telegram_id,
        memo,
      );

      if (transferResult.success) {
        await this.knexService.knex('transaction')
          .update({ settled: true })
          .where('payhere_pay_id', payhere_pay_id);

        await this.dbLogger.info(
          `Settlement retry successful for transaction ${payhere_pay_id}: ${satoshis_purchased} satoshis transferred to user ${telegram_id}`,
        );
      } else {
        await this.dbLogger.warn(
          `Settlement retry failed for transaction ${payhere_pay_id}: ${transferResult.message}`,
        );
      }
    } catch (error) {
      await this.dbLogger.error(
        `Settlement retry error for transaction ${payhere_pay_id}: ${error.message}`,
      );
    }
  }
}