import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, timingSafeEqual } from 'crypto';
import type { Knex } from 'knex';
import Big from 'big.js';
import { KnexService } from '../knex/knex.service';
import { Subscription } from '../../models/subscription';
import { BitcoinPriceService } from '../bitcoin-price/bitcoin-price.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';
import { PayHereService } from '../payhere/payhere.service';
import { PayHereNotificationDto } from './dto/payhere-notification.dto';
import { errorMessage } from '../../common/error-message';

export type PayHereNotificationParams = PayHereNotificationDto;

export type Status =
  | 'SUCCESS'
  | 'PENDING'
  | 'CANCELLED'
  | 'FAILED'
  | 'CHARGEBACK';

export interface Transaction {
  payhere_pay_id: string;
  payhere_sub_id: string;
  status: Status;
  btc_price_at_purchase?: number;
  satoshis_purchased?: number;
  price_currency?: string;
  coingecko_timestamp?: Date;
  settled?: boolean;
  retry_count?: number;
  last_retry_at?: Date;
  gross_amount?: number;
  payment_processor_fee_basis_points?: number;
  payment_processor_fee_amount?: number;
  bitcoindeepa_fee_basis_points?: number;
  bitcoindeepa_fee_amount?: number;
  net_amount?: number;
  created_at?: Date;
  updated_at?: Date;
}

type BitcoinData = Pick<
  Transaction,
  | 'btc_price_at_purchase'
  | 'satoshis_purchased'
  | 'price_currency'
  | 'coingecko_timestamp'
  | 'gross_amount'
  | 'payment_processor_fee_basis_points'
  | 'payment_processor_fee_amount'
  | 'bitcoindeepa_fee_basis_points'
  | 'bitcoindeepa_fee_amount'
  | 'net_amount'
>;

export interface DcaSummary {
  dca: {
    balance: number;
    /** Amount that went into BTC (after fees) */
    spent: number;
    /** Payment processor + BitcoinDeepa fees on those purchases */
    fees: number;
    avg_btc_price: number;
  };
  total_balance: number;
  total_lkr: string;
  currency: string;
  '24_hr_change': number;
  current_btc_price?: {
    usd: number;
    lkr: number;
  };
}

export interface PaginatedTransactions {
  transactions: Transaction[];
  total_count: number;
  total_pages: number;
  current_page: number;
  has_more: boolean;
}

const SATOSHIS_PER_BTC = 100_000_000;

// Unpriced payments older than this are alerted, not auto-priced and paid.
const BACKFILL_MAX_AGE_HOURS = 24;

const PACKAGE_COLUMNS = [
  'p.amount as package_amount',
  'p.currency as package_currency',
  'p.name as package_name',
  'p.frequency as package_frequency',
];

function md5Upper(input: string): string {
  return createHash('md5').update(input).digest('hex').toUpperCase();
}

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly bitcoinPriceService: BitcoinPriceService,
    private readonly redisService: RedisService,
    private readonly telegramLoggerService: TelegramLoggerService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
    private readonly payHereService: PayHereService,
  ) {}

  /**
   * Re-enable settlement for ONE payment, after a human has checked it.
   * Deliberately not a bulk reset: rows stopped with an unknown outcome (e.g.
   * a timeout) may already have been paid, so each needs checking on
   * BitcoinDeepa before it is retried.
   *
   * Payments attempted before the memo became `DCA purchase (Ref: <id>)` were
   * sent as `<package> DCA plan (Ref: <id>)`. The bot dedupes on the memo, so
   * it won't recognise a retry of one of those: check those by hand first.
   */
  async resetRetryCount(
    payhere_pay_id: string,
  ): Promise<{ payhere_pay_id: string }> {
    const updated = await this.knexService
      .knex('transaction')
      .where({ payhere_pay_id, settled: false })
      .update({ retry_count: 0, last_retry_at: null });
    if (!updated) {
      throw new NotFoundException(
        `No unsettled transaction with payment_id ${payhere_pay_id}`,
      );
    }

    this.logger.warn(`Settlement retries reset for ${payhere_pay_id}`);
    return { payhere_pay_id };
  }

  /**
   * PayHere md5sig = MD5(merchant_id + order_id + amount + currency +
   * status_code + MD5(merchant_secret)). Note it does NOT cover payment_id,
   * subscription_id or custom_* - those are cross-checked against the DB in
   * handlePayHereNotification (order_id + user binding), which stops a
   * captured notification being reused for another user or subscription.
   *
   * A replay with an invented payment_id still passes this check, and
   * getting a genuine signed notification is easy: notify_url is an unsigned
   * checkout parameter, so a payer can point it at their own server. Such
   * payments are recorded but never paid out - settlement only pays a
   * payment_id that PayHere's API lists as RECEIVED.
   */
  isValidPayHereSignature(data: PayHereNotificationParams): boolean {
    const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET;
    if (!merchantSecret || !data.md5sig) {
      return false;
    }

    const expected = md5Upper(
      `${data.merchant_id}${data.order_id}${data.payhere_amount}${data.payhere_currency}${data.status_code}${md5Upper(merchantSecret)}`,
    );
    const received = String(data.md5sig).toUpperCase();

    return (
      expected.length === received.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(received))
    );
  }

  /**
   * Who a notification's payment belongs to, from our own records (never
   * custom_1). For logging; resolveSubscription is what actually decides.
   */
  async getNotificationOwner(
    order_id: string,
    subscription_id: string,
  ): Promise<string | null> {
    const sub = await this.knexService
      .knex<Subscription>('subscription')
      .select('user_id')
      .where('payhere_sub_id', subscription_id)
      .first();
    if (sub) return sub.user_id;
    const order = await this.knexService
      .knex<{ order_id: string; user_id: string }>('payhere_order')
      .select('user_id')
      .where('order_id', order_id)
      .first();
    return order?.user_id ?? null;
  }

  /**
   * Record a PayHere notification. The caller must have checked
   * isValidPayHereSignature first (the controller does, before anything is
   * logged).
   */
  async handlePayHereNotification(
    data: PayHereNotificationParams,
  ): Promise<void> {
    const {
      order_id,
      payhere_amount,
      payhere_currency,
      status_code,
      payment_id,
      subscription_id,
      message_type,
      item_rec_status,
    } = data;

    if (!payment_id || !subscription_id || Number(subscription_id) < 0) {
      this.logger.error(
        `Invalid payment/subscription id: payment_id=${payment_id}, subscription_id=${subscription_id}`,
      );
      throw new BadRequestException('Invalid payment or subscription id');
    }

    const status = this.getPayHereStatusMapped(status_code);
    this.logger.log(
      `Processing PayHere notification: payment_id=${payment_id}, subscription_id=${subscription_id}, status=${status}, amount=${payhere_amount} ${payhere_currency}`,
    );

    // Pre-fetch Bitcoin data outside the DB transaction to keep it short
    const existing = await this.knexService
      .knex<Transaction>('transaction')
      .where('payhere_pay_id', payment_id)
      .first();

    let bitcoinData: BitcoinData | null = null;
    if (
      status === 'SUCCESS' &&
      (!existing ||
        (existing.status !== 'CHARGEBACK' && !existing.satoshis_purchased))
    ) {
      bitcoinData = await this.fetchBitcoinDataForTransaction(
        parseFloat(payhere_amount),
        payhere_currency,
      );
    }

    // PayHere stopped (retries exhausted / cancelled) or completed the plan
    const subscriptionEnded =
      item_rec_status === '-1' ||
      item_rec_status === '1' ||
      message_type === 'RECURRING_STOPPED' ||
      message_type === 'RECURRING_COMPLETE';

    const alerts: string[] = [];
    // Set when this notification is what made the payment SUCCESS (a resent
    // SUCCESS must not re-activate a plan the user has since cancelled).
    let becameSuccess = false;
    let duplicate: { payhere_sub_id: string; activeSubId: string } | null =
      null;
    let createdSubscription: { user_id: string; package_id: string } | null =
      null;
    let subscriptionUserId = '';

    const trx = await this.knexService.knex.transaction();
    try {
      const { subscription, created } = await this.resolveSubscription(trx, {
        subscription_id,
        order_id,
        status,
      });
      subscriptionUserId = subscription.user_id;
      if (created) {
        createdSubscription = {
          user_id: subscription.user_id,
          package_id: subscription.package_id,
        };
      }

      if (subscriptionEnded && subscription.is_active) {
        await trx('subscription')
          .update({ is_active: false, updated_at: trx.fn.now() })
          .where('payhere_sub_id', subscription_id);
        alerts.push(
          `PayHere ended subscription ${subscription_id} (user ${subscription.user_id}): message_type=${message_type ?? '-'}, item_rec_status=${item_rec_status ?? '-'}. Marked inactive.`,
        );
      }

      const current: Transaction | undefined = await trx('transaction')
        .where('payhere_pay_id', payment_id)
        .forUpdate()
        .first();

      if (current) {
        if (current.payhere_sub_id !== subscription_id) {
          throw new BadRequestException(
            'payment_id belongs to a different subscription',
          );
        }

        if (!this.isAllowedTransition(current.status, status)) {
          this.logger.warn(
            `Ignoring status change ${current.status} → ${status} for payment_id ${payment_id} (out-of-order or duplicate notification)`,
          );
        } else {
          const update: Partial<Transaction> = { status };
          if (bitcoinData && !current.satoshis_purchased) {
            Object.assign(update, bitcoinData);
          }
          await trx('transaction')
            .update(update)
            .where('payhere_pay_id', payment_id);
          becameSuccess = status === 'SUCCESS' && current.status !== 'SUCCESS';

          if (status === 'CHARGEBACK' && current.status !== 'CHARGEBACK') {
            alerts.push(
              current.settled
                ? `CHARGEBACK on settled payment ${payment_id} (sub ${subscription_id}, user ${subscription.user_id}). ${current.satoshis_purchased} sats were already sent - manual reversal needed.`
                : `CHARGEBACK on unsettled payment ${payment_id} (sub ${subscription_id}, user ${subscription.user_id}). It will not be settled.`,
            );
          }

          this.logger.log(
            `Transaction ${payment_id} updated: ${current.status} → ${status}`,
          );
        }
      } else {
        const row: Transaction = {
          payhere_pay_id: payment_id,
          payhere_sub_id: subscription_id,
          status,
          retry_count: 0,
          gross_amount: parseFloat(payhere_amount),
          ...(bitcoinData ?? {}),
        };
        await trx('transaction').insert(row);
        becameSuccess = status === 'SUCCESS';

        this.logger.log(
          `New transaction ${payment_id} created (status ${status})`,
        );
      }

      if (becameSuccess && !subscriptionEnded) {
        const duplicateOf = await this.activateIfFirstSuccess(
          trx,
          subscription,
          payment_id,
        );
        if (duplicateOf) {
          duplicate = {
            payhere_sub_id: subscription_id,
            activeSubId: duplicateOf,
          };
        }
      }

      await trx.commit();
    } catch (error: unknown) {
      if (!trx.isCompleted()) {
        await trx.rollback();
      }
      // A correctly signed notification we refuse is a real PayHere event we
      // didn't record (e.g. unknown order_id) - a human needs to look at it.
      if (error instanceof BadRequestException) {
        await this.telegramLoggerService.logAlert(
          'PayHere webhook',
          `Rejected signed notification payment_id=${payment_id}, order_id=${order_id}, subscription_id=${subscription_id}: ${errorMessage(error)}`,
        );
      }
      this.logger.error(
        `PayHere notification processing failed for payment_id ${payment_id}: ${errorMessage(error)}`,
      );
      throw error;
    }

    // Side effects only after the DB commit succeeded
    if (createdSubscription) {
      await this.notifySubscriptionCreated(
        subscription_id,
        createdSubscription.user_id,
        createdSubscription.package_id,
      );
    }
    if (duplicate) {
      alerts.push(
        await this.cancelDuplicateSubscription(
          duplicate.payhere_sub_id,
          duplicate.activeSubId,
          subscriptionUserId,
        ),
      );
    }
    for (const alert of alerts) {
      this.logger.error(alert);
      await this.telegramLoggerService.logAlert('PayHere webhook', alert);
    }
    await this.invalidateUserCaches(subscriptionUserId);
  }

  getPayHereStatusMapped(status_code: string): Status {
    const statusMap: Record<string, Status> = {
      '2': 'SUCCESS',
      '0': 'PENDING',
      '-1': 'CANCELLED',
      '-2': 'FAILED',
      '-3': 'CHARGEBACK',
    };

    return statusMap[status_code] ?? 'FAILED';
  }

  /**
   * SUCCESS can only move to CHARGEBACK, CHARGEBACK is final, and nothing
   * moves back to PENDING. Same-status repeats are allowed (idempotent).
   */
  private isAllowedTransition(from: Status, to: Status): boolean {
    if (from === to) return true;
    if (from === 'CHARGEBACK') return false;
    if (from === 'SUCCESS') return to === 'CHARGEBACK';
    return to !== 'PENDING';
  }

  /**
   * Find the subscription for this notification, or create it on first sight.
   *
   * Only signed fields decide who owns a subscription: order_id is covered by
   * the md5sig, and the user/package come from the payhere_order row we stored
   * when generating the checkout link. custom_1/custom_2 are NOT used - the
   * checkout hash doesn't cover them, so a payer can edit them (e.g. to give
   * an un-KYC'd account a subscription).
   */
  private async resolveSubscription(
    trx: Knex.Transaction,
    params: {
      subscription_id: string;
      order_id: string;
      status: Status;
    },
  ): Promise<{ subscription: Subscription; created: boolean }> {
    const { subscription_id, order_id, status } = params;

    const existing: Subscription | undefined = await trx('subscription')
      .where('payhere_sub_id', subscription_id)
      .forUpdate()
      .first();

    if (existing) {
      if (existing.payhere_order_id && existing.payhere_order_id !== order_id) {
        throw new BadRequestException(
          'order_id does not match the subscription',
        );
      }
      if (!existing.payhere_order_id) {
        // Subscriptions from before order binding have no order_id yet. The
        // first notification binds one - but subscription_id isn't signed, so
        // an attacker could replay their own signed notification (for an
        // order they made) against a victim's subscription and lock it to the
        // wrong order. Every order since binding has a payhere_order row, so
        // it must belong to this subscription's user. Old orders have no row
        // and only arrive as genuine renewals.
        const order = await trx<{ user_id: string }>('payhere_order')
          .select('user_id')
          .where('order_id', order_id)
          .first();
        if (order && order.user_id !== existing.user_id) {
          throw new BadRequestException(
            'order_id belongs to another user than the subscription',
          );
        }
        await this.assertOrderIdUnused(trx, order_id, subscription_id);
        await trx('subscription')
          .update({ payhere_order_id: order_id })
          .where('payhere_sub_id', subscription_id);
        existing.payhere_order_id = order_id;
      }
      return { subscription: existing, created: false };
    }

    const order = await trx<{ user_id: string; package_id: string }>(
      'payhere_order',
    )
      .select('user_id', 'package_id')
      .where('order_id', order_id)
      .first();
    if (!order) {
      throw new BadRequestException(
        `Unknown order_id ${order_id} - no checkout link was generated for it`,
      );
    }
    const { user_id, package_id } = order;
    await this.assertOrderIdUnused(trx, order_id, subscription_id);

    const subscription: Subscription = {
      payhere_sub_id: subscription_id,
      payhere_order_id: order_id,
      user_id,
      package_id,
      // Always created inactive. activateIfFirstSuccess (run for SUCCESS)
      // activates it, unless the user already has another active plan - e.g.
      // they opened two checkout links and paid both.
      is_active: false,
    } as Subscription;
    await trx('subscription').insert(subscription);

    this.logger.log(
      `Created subscription ${subscription_id} for user ${user_id}, package ${package_id} (first status: ${status})`,
    );
    return { subscription, created: true };
  }

  private async assertOrderIdUnused(
    trx: Knex.Transaction,
    order_id: string,
    subscription_id: string,
  ): Promise<void> {
    const other: Subscription | undefined = await trx('subscription')
      .where('payhere_order_id', order_id)
      .whereNot('payhere_sub_id', subscription_id)
      .forUpdate()
      .first();
    if (!other) return;

    // A declined first charge leaves an inactive, never-paid subscription
    // holding the order_id. If the payer retries on the same checkout page
    // and PayHere issues a new subscription_id, the retry must still be
    // accepted - so release the order_id from the failed attempt.
    const otherWasPaid: unknown = await trx('transaction')
      .where('payhere_sub_id', other.payhere_sub_id)
      .whereIn('status', ['SUCCESS', 'CHARGEBACK'])
      .first();
    if (other.is_active || otherWasPaid) {
      throw new BadRequestException(
        'order_id is already bound to another subscription',
      );
    }
    await trx('subscription')
      .update({ payhere_order_id: null, updated_at: trx.fn.now() })
      .where('payhere_sub_id', other.payhere_sub_id);
    this.logger.warn(
      `order_id ${order_id} moved from never-paid subscription ${other.payhere_sub_id} to ${subscription_id} (checkout retry)`,
    );
  }

  /**
   * Subscriptions start inactive. Activate one on its first SUCCESS - but
   * never re-activate a cancelled one (those already had a SUCCESS) and never
   * create a second active plan. Returns the user's other active
   * subscription id when this one is a duplicate (left inactive).
   */
  private async activateIfFirstSuccess(
    trx: Knex.Transaction,
    subscription: Subscription,
    payment_id: string,
  ): Promise<string | null> {
    if (subscription.is_active) return null;

    const priorSuccess = await trx('transaction')
      .where('payhere_sub_id', subscription.payhere_sub_id)
      .whereIn('status', ['SUCCESS', 'CHARGEBACK'])
      .whereNot('payhere_pay_id', payment_id)
      .first();
    if (priorSuccess) return null;

    // Lock the user so two first payments arriving at the same moment (two
    // checkouts) run this check one after the other; otherwise neither sees
    // the other's uncommitted activation and both go active.
    // NO KEY UPDATE, not FOR UPDATE: the subscription insert already holds an
    // FK share lock on this user row, and FOR UPDATE would conflict with the
    // other webhook's share lock - two concurrent first payments deadlock.
    await trx('user')
      .where('id', subscription.user_id)
      .forNoKeyUpdate()
      .first();

    const otherActive: Subscription | undefined = await trx('subscription')
      .where('user_id', subscription.user_id)
      .where('is_active', true)
      .whereNot('payhere_sub_id', subscription.payhere_sub_id)
      .first();
    if (otherActive) {
      this.logger.warn(
        `Subscription ${subscription.payhere_sub_id} got its first SUCCESS (${payment_id}) but user ${subscription.user_id} already has active subscription ${otherActive.payhere_sub_id} - leaving it inactive`,
      );
      return otherActive.payhere_sub_id;
    }

    await trx('subscription')
      .update({ is_active: true, updated_at: trx.fn.now() })
      .where('payhere_sub_id', subscription.payhere_sub_id);
    this.logger.log(
      `Subscription ${subscription.payhere_sub_id} activated by first successful payment ${payment_id}`,
    );
    return null;
  }

  /**
   * A user paid a second checkout while another plan was active. Its first
   * charge is still settled (they paid for those sats), but PayHere would
   * keep billing a plan the user can't see or cancel - so cancel it there.
   * Returns the alert text for the team.
   */
  private async cancelDuplicateSubscription(
    payhere_sub_id: string,
    activeSubId: string,
    user_id: string,
  ): Promise<string> {
    const base = `Duplicate subscription ${payhere_sub_id}: user ${user_id} already has active plan ${activeSubId}, so it was left inactive (its first payment is still settled).`;
    try {
      const result =
        await this.payHereService.cancelSubscription(payhere_sub_id);
      return result.status === 1
        ? `${base} Cancelled at PayHere.`
        : `${base} PayHere refused to cancel it (${result.msg}) - cancel it manually.`;
    } catch (error: unknown) {
      return `${base} Cancelling at PayHere failed (${errorMessage(error)}) - cancel it manually.`;
    }
  }

  private async notifySubscriptionCreated(
    subscription_id: string,
    user_id: string,
    package_id: string,
  ): Promise<void> {
    try {
      const pkg = await this.knexService
        .knex('package')
        .where('id', package_id)
        .first();
      if (pkg) {
        await this.telegramLoggerService.logSubscriptionCreated(
          subscription_id,
          user_id,
          pkg,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to log subscription creation to Telegram: ${errorMessage(error)}`,
      );
    }
  }

  private async fetchBitcoinDataForTransaction(
    amount: number,
    currency: string,
  ): Promise<BitcoinData | null> {
    try {
      if (process.env.ENABLE_BITCOIN_TRACKING === 'false') {
        this.logger.log(
          'Bitcoin tracking is disabled - skipping Bitcoin data fetch',
        );
        return null;
      }

      const paymentProcessorFeeBps = parseInt(
        process.env.PAYHERE_FEE_BASIS_POINTS || '0',
        10,
      );
      const bitcoindeepaFeeBps = parseInt(
        process.env.BITCOINDEEPA_FEE_BASIS_POINTS || '0',
        10,
      );

      const gross = new Big(amount);
      const paymentProcessorFee = gross
        .times(paymentProcessorFeeBps)
        .div(10000);
      const bitcoindeepaFee = gross.times(bitcoindeepaFeeBps).div(10000);
      const totalFees = paymentProcessorFee.plus(bitcoindeepaFee);
      const netAmount = gross.minus(totalFees).toNumber();

      const calc = await this.bitcoinPriceService.calculateSatoshis(
        netAmount,
        currency,
      );
      if (!calc) {
        this.logger.warn(
          `Failed to fetch Bitcoin price for ${netAmount} ${currency} - will be backfilled later`,
        );
        return null;
      }

      this.logger.log(
        `Bitcoin DCA calculation: ${amount} ${currency} gross, ${totalFees.toString()} fees, ${netAmount} net = ${calc.satoshis} sats at ${calc.btc_price} ${currency}/BTC`,
      );

      return {
        btc_price_at_purchase: calc.btc_price,
        satoshis_purchased: calc.satoshis,
        price_currency: calc.currency,
        coingecko_timestamp: new Date(),
        gross_amount: amount,
        payment_processor_fee_basis_points: paymentProcessorFeeBps,
        payment_processor_fee_amount: paymentProcessorFee.toNumber(),
        bitcoindeepa_fee_basis_points: bitcoindeepaFeeBps,
        bitcoindeepa_fee_amount: bitcoindeepaFee.toNumber(),
        net_amount: netAmount,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Error fetching Bitcoin data for transaction (${amount} ${currency}): ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * SUCCESS payments saved without price data (price API was down at webhook
   * time) are never settled. Fill them in with the current price.
   *
   * Only recent payments: the backfilled amount is settled automatically, and
   * pricing an old payment at today's rate (e.g. rows from before tracking
   * was enabled) is a payout decision for a human - see
   * alertStaleUnpricedPayments.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async backfillMissingBitcoinData(): Promise<void> {
    if (process.env.ENABLE_BITCOIN_TRACKING === 'false') return;

    try {
      const rows = await this.transactionsWithPackage()
        .select(
          't.payhere_pay_id',
          't.gross_amount',
          'p.amount as package_amount',
          'p.currency as package_currency',
          's.user_id',
        )
        .where('t.status', 'SUCCESS')
        .whereNull('t.satoshis_purchased')
        .where(
          't.created_at',
          '>=',
          this.knexService.knex.raw(
            `now() - interval '${BACKFILL_MAX_AGE_HOURS} hours'`,
          ),
        )
        .limit(50);

      for (const row of rows) {
        const amount = Number(row.gross_amount ?? row.package_amount);
        const data = await this.fetchBitcoinDataForTransaction(
          amount,
          row.package_currency,
        );
        if (!data) {
          return; // price source still down - try again next run
        }

        const updated = await this.knexService
          .knex('transaction')
          .update(data)
          .where('payhere_pay_id', row.payhere_pay_id)
          .where('status', 'SUCCESS')
          .whereNull('satoshis_purchased');

        if (updated) {
          this.logger.warn(
            `Backfilled Bitcoin data for ${row.payhere_pay_id}: ${data.satoshis_purchased} sats at ${data.btc_price_at_purchase} (price taken at backfill time)`,
          );
          await this.invalidateUserCaches(row.user_id);
        }
      }
    } catch (error: unknown) {
      this.logger.error(`Bitcoin data backfill failed: ${errorMessage(error)}`);
    }
  }

  /** Unpriced SUCCESS payments too old to backfill need a manual decision. */
  @Cron(CronExpression.EVERY_6_HOURS)
  async alertStaleUnpricedPayments(): Promise<void> {
    try {
      const rows = await this.knexService
        .knex<{ payhere_pay_id: string }>('transaction')
        .select('payhere_pay_id')
        .where('status', 'SUCCESS')
        .whereNull('satoshis_purchased')
        .where(
          'created_at',
          '<',
          this.knexService.knex.raw(
            `now() - interval '${BACKFILL_MAX_AGE_HOURS} hours'`,
          ),
        )
        .orderBy('created_at')
        .limit(20);
      if (rows.length === 0) return;

      const ids = rows.map((r) => r.payhere_pay_id).join(', ');
      await this.telegramLoggerService.logAlert(
        'Backfill',
        `SUCCESS payments older than ${BACKFILL_MAX_AGE_HOURS}h have no BTC price and will NOT be settled automatically${rows.length === 20 ? ' (first 20)' : ''}: ${ids}. Price and settle them manually.`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Stale unpriced payment check failed: ${errorMessage(error)}`,
      );
    }
  }

  async getTransactionsByUserIdPaginated(
    user_id: string,
    page: number,
    limit: number,
  ): Promise<PaginatedTransactions> {
    const result = await this.redisService.getOrSet(
      CacheKeys.transaction.list(user_id, page, limit),
      120,
      () => this.loadTransactionsPage(user_id, page, limit),
    );
    return result!;
  }

  private async loadTransactionsPage(
    user_id: string,
    page: number,
    limit: number,
  ): Promise<PaginatedTransactions> {
    const subscriptionIds = await this.getSubscriptionIds(user_id);
    if (subscriptionIds.length === 0) {
      return {
        transactions: [],
        total_count: 0,
        total_pages: 0,
        current_page: page,
        has_more: false,
      };
    }

    const [countResult] = await this.knexService
      .knex('transaction')
      .whereIn('payhere_sub_id', subscriptionIds)
      .count<{ count: string }[]>('* as count');

    const totalCount = Number(countResult.count);
    const totalPages = Math.ceil(totalCount / limit);

    // Joined with package info so callers get the LKR amount and plan name
    const transactions = await this.transactionsWithPackage()
      .select('t.*', ...PACKAGE_COLUMNS)
      .whereIn('t.payhere_sub_id', subscriptionIds)
      .orderBy('t.created_at', 'desc')
      .limit(limit)
      .offset((page - 1) * limit);

    return {
      transactions,
      total_count: totalCount,
      total_pages: totalPages,
      current_page: page,
      has_more: page < totalPages,
    };
  }

  async getLatestTransactionForUser(
    user_id: string,
  ): Promise<Record<string, unknown> | null> {
    return this.redisService.getOrSet(
      CacheKeys.transaction.latest(user_id),
      60,
      () => this.loadLatestTransaction(user_id),
    );
  }

  private async loadLatestTransaction(
    user_id: string,
  ): Promise<Record<string, unknown> | null> {
    const activeSubscription: Subscription | undefined = await this.knexService
      .knex<Subscription>('subscription')
      .where('user_id', user_id)
      .where('is_active', true)
      .orderBy('created_at', 'desc')
      .first();

    if (!activeSubscription) {
      return null;
    }

    const result: Record<string, unknown> | undefined =
      await this.transactionsWithPackage()
        .select(
          't.payhere_pay_id',
          't.payhere_sub_id',
          't.status',
          't.btc_price_at_purchase',
          't.satoshis_purchased',
          't.price_currency',
          't.coingecko_timestamp',
          't.created_at',
          't.updated_at',
          ...PACKAGE_COLUMNS,
        )
        .where('t.payhere_sub_id', activeSubscription.payhere_sub_id)
        .orderBy('t.created_at', 'desc')
        .first();

    return result ?? null;
  }

  async getDCASummaryForUser(user_id: string): Promise<DcaSummary> {
    const summary = await this.redisService.getOrSet(
      CacheKeys.transaction.dcaSummary(user_id),
      300,
      () => this.computeDcaSummary(user_id),
    );
    return summary!;
  }

  private async computeDcaSummary(user_id: string): Promise<DcaSummary> {
    const subscriptionIds = await this.getSubscriptionIds(user_id);
    const transactions: Transaction[] =
      subscriptionIds.length === 0
        ? []
        : await this.knexService
            .knex<Transaction>('transaction')
            .whereIn('payhere_sub_id', subscriptionIds)
            .whereNotNull('satoshis_purchased')
            .where('status', 'SUCCESS');

    let totalSatoshis = new Big(0);
    // "Invested" excludes fees so Current Value vs Invested shows market
    // movement only; fees are reported separately.
    let totalSpent = new Big(0); // net amount that bought BTC
    let totalFees = new Big(0);
    let totalBtcCost = new Big(0); // market value at purchase (for avg price)

    for (const tx of transactions) {
      if (!tx.satoshis_purchased) continue;
      const sats = new Big(tx.satoshis_purchased);
      totalSatoshis = totalSatoshis.plus(sats);

      const btcCost = tx.btc_price_at_purchase
        ? sats.div(SATOSHIS_PER_BTC).times(tx.btc_price_at_purchase)
        : new Big(0);
      totalBtcCost = totalBtcCost.plus(btcCost);
      // Rows from before the fee columns lack net_amount - use the BTC cost
      totalSpent = totalSpent.plus(
        tx.net_amount != null ? new Big(tx.net_amount) : btcCost,
      );
      totalFees = totalFees
        .plus(tx.payment_processor_fee_amount ?? 0)
        .plus(tx.bitcoindeepa_fee_amount ?? 0);
    }

    const averageBTCPrice =
      totalSatoshis.gt(0) && totalBtcCost.gt(0)
        ? totalBtcCost.div(totalSatoshis.div(SATOSHIS_PER_BTC))
        : new Big(0);

    const market = await this.fetchBalanceAndMarket(user_id);

    return {
      dca: {
        balance: totalSatoshis.toNumber(),
        spent: totalSpent.toNumber(),
        fees: totalFees.toNumber(),
        avg_btc_price: averageBTCPrice.toNumber(),
      },
      currency: 'LKR',
      ...market,
    };
  }

  /** transaction t → subscription s → package p */
  private transactionsWithPackage() {
    return this.knexService
      .knex('transaction as t')
      .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
      .join('package as p', 's.package_id', 'p.id');
  }

  private async getSubscriptionIds(user_id: string): Promise<string[]> {
    const rows = await this.knexService
      .knex<Subscription>('subscription')
      .select('payhere_sub_id')
      .where('user_id', user_id);
    return rows.map((row) => row.payhere_sub_id);
  }

  /** Wallet balance (BitcoinDeepa) + market data (CMC). Never throws. */
  private async fetchBalanceAndMarket(
    user_id: string,
  ): Promise<Omit<DcaSummary, 'dca' | 'currency'>> {
    let total_balance = 0;
    let total_lkr = '0.00';
    if (this.bitcoinDeepaService.isConfigured()) {
      const balance = await this.bitcoinDeepaService.getUserBalance(
        parseInt(user_id, 10),
      );
      if (balance.success) {
        total_balance = balance.balance ?? 0;
        total_lkr = balance.balance_lkr ?? '0.00';
      }
    }

    let change24h = 0;
    let currentPrice: { usd: number; lkr: number } | null = null;
    try {
      change24h = (await this.bitcoinPriceService.getBitcoin24HrChange()) ?? 0;
      currentPrice = await this.bitcoinPriceService.getCurrentPrice();
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to fetch market data for user ${user_id}: ${errorMessage(error)}`,
      );
    }

    return {
      total_balance,
      total_lkr,
      '24_hr_change': change24h,
      current_btc_price: currentPrice
        ? { usd: currentPrice.usd, lkr: currentPrice.lkr }
        : undefined,
    };
  }

  /** Clear every per-user cache that a payment can change. Never throws. */
  async invalidateUserCaches(user_id: string): Promise<void> {
    await this.redisService.del(CacheKeys.transaction.latest(user_id));
    await this.redisService.del(CacheKeys.transaction.dcaSummary(user_id));
    await this.redisService.del(CacheKeys.user.subscription(user_id));
    await this.redisService.delByPattern(
      CacheKeys.patterns.userTransactionLists(user_id),
    );
  }
}
