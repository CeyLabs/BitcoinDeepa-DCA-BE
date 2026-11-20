import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KnexService } from '../knex/knex.service';
import { CeyPayService } from '../ceypay/ceypay.service';
import { errorMessage } from '../../common/error-message';
import { payoutAttemptDue, SellOrderRow, SellService } from './sell.service';
import { SellStatus } from './sell.constants';

/** Payouts with no webhook after this long are checked with CeyPay */
const POLL_AFTER_MINUTES = 10;

@Injectable()
export class SellSettlementService {
  private readonly logger = new Logger(SellSettlementService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly sellService: SellService,
    private readonly ceyPay: CeyPayService,
  ) {}

  /** Quotes nobody confirmed in time. Nothing was moved for these. */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireQuotes(): Promise<void> {
    try {
      await this.knexService
        .knex('sell_order')
        .where('status', SellStatus.QUOTED)
        .where('expires_at', '<', this.knexService.knex.fn.now())
        .update({
          status: SellStatus.EXPIRED,
          updated_at: this.knexService.knex.fn.now(),
        });
    } catch (error) {
      this.logger.error(`Expiring sell quotes failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Sales waiting for the user to approve the payment: follow their bot
   * request (paid -> payout, declined/failed -> nothing sold) and withdraw it
   * once the approval window passed. The app's order reads sync too; this
   * covers users who approve in the bot chat and close the app.
   */
  // waitForCompletion: a slow bot can make a run longer than 10s; the next
  // one starts only after it, so requests aren't asked about twice at once
  @Cron(CronExpression.EVERY_10_SECONDS, { waitForCompletion: true })
  async syncCollects(): Promise<void> {
    try {
      const rows = await this.knexService
        .knex<SellOrderRow>('sell_order')
        .where('status', SellStatus.COLLECTING)
        .whereNotNull('collect_expires_at')
        .orderBy('updated_at')
        .limit(50);
      for (const row of rows) {
        try {
          await this.sellService.syncCollect(row);
        } catch (error) {
          this.logger.warn(
            `Sell ${row.id}: collect sync failed: ${errorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Sell collect sync failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Collected orders whose CeyPay payout wasn't created (CeyPay down). Retry n
   * waits 2^n minutes; CeyPay dedupes on externalRef, so a retry after a lost
   * response returns the same off-ramp.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async retryPayouts(): Promise<void> {
    if (!this.ceyPay.isConfigured()) return;
    try {
      const rows = await this.knexService
        .knex<SellOrderRow>('sell_order')
        .select('id')
        .where('status', SellStatus.SATS_COLLECTED)
        .whereNull('ceypay_payment_id')
        .where(payoutAttemptDue)
        .orderBy('created_at')
        .limit(20);
      for (const { id } of rows) {
        await this.sellService.createPayout(id);
      }
    } catch (error) {
      this.logger.error(`Sell payout retry failed: ${errorMessage(error)}`);
    }
  }

  /** Orders stuck mid-transfer go to a human (see SellService.recoverStuckOrders). */
  @Cron(CronExpression.EVERY_MINUTE)
  async recoverStuckOrders(): Promise<void> {
    try {
      await this.sellService.recoverStuckOrders();
    } catch (error) {
      this.logger.error(
        `Recovering stuck sells failed: ${errorMessage(error)}`,
      );
    }
  }

  /** Report payouts CeyPay hasn't finished after 2 hours (once each). */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async alertStalePayouts(): Promise<void> {
    try {
      await this.sellService.alertStalePayouts();
    } catch (error) {
      this.logger.error(`Stale payout check failed: ${errorMessage(error)}`);
    }
  }

  /** Fallback for missed webhooks: ask CeyPay about old pending payouts. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollPendingPayouts(): Promise<void> {
    if (!this.ceyPay.isConfigured()) return;
    const knex = this.knexService.knex;
    try {
      const rows = await knex<SellOrderRow>('sell_order')
        .select('id', 'ceypay_payment_id')
        .where('status', SellStatus.PAYOUT_PENDING)
        .whereNotNull('ceypay_payment_id')
        .whereRaw(
          `updated_at <= now() - interval '${POLL_AFTER_MINUTES} minutes'`,
        )
        .orderBy('updated_at')
        .limit(50);

      for (const row of rows) {
        try {
          const offramp = await this.ceyPay.getOfframp(row.ceypay_payment_id!);
          if (offramp.status === 'COMPLETED' || offramp.status === 'FAILED') {
            await this.sellService.applyOfframp(row.id, offramp);
          } else {
            // Still in flight: push it to the back of the queue
            await knex('sell_order')
              .where({ id: row.id, status: SellStatus.PAYOUT_PENDING })
              .update({ updated_at: knex.fn.now() });
          }
        } catch (error) {
          this.logger.warn(
            `Polling CeyPay for sell ${row.id} failed: ${errorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Sell payout poll failed: ${errorMessage(error)}`);
    }
  }
}
