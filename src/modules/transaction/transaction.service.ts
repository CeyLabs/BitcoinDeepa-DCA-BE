import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, timingSafeEqual } from 'crypto';
import type { Knex } from 'knex';
import Big from 'big.js';
import { KnexService } from '../knex/knex.service';
import { Subscription } from '../../models/subscription';
import { BitcoinPriceService } from '../bitcoin-price/bitcoin-price.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';
import { PayHereNotificationDto } from './dto/payhere-notification.dto';

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
    spent: number;
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

function md5Upper(input: string): string {
  return createHash('md5').update(input).digest('hex').toUpperCase();
}

@Injectable()
export class TransactionService {
  constructor(
    private readonly knexService: KnexService,
    private readonly bitcoinPriceService: BitcoinPriceService,
    private readonly dbLogger: DatabaseLoggerService,
    private readonly redisService: RedisService,
    private readonly telegramLoggerService: TelegramLoggerService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
  ) {}

  async resetRetryCounts(): Promise<{ reset_count: number }> {
    const updated = await this.knexService
      .knex('transaction')
      .where('settled', false)
      .update({ retry_count: 0 });

    await this.dbLogger.info(
      `Reset retry_count to 0 for ${updated} unsettled transaction(s)`,
    );

    return { reset_count: updated };
  }

  /**
   * PayHere md5sig = MD5(merchant_id + order_id + amount + currency +
   * status_code + MD5(merchant_secret)). Note it does NOT cover payment_id,
   * subscription_id or custom_* - those are cross-checked against the DB in
   * handlePayHereNotification (order_id + user binding), which stops a
   * captured notification being reused for another user or subscription.
   *
   * We intentionally don't try to detect a replayed notification with a new
   * payment_id beyond that: it needs a genuine signed notification (HTTPS
   * interception or log access), and every heuristic we tried (e.g. "charged
   * too soon") also flagged PayHere's own retries and sandbox renewals.
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
      custom_1: user_id,
      custom_2: package_id,
      message_type,
      item_rec_status,
    } = data;

    if (!this.isValidPayHereSignature(data)) {
      // Never log the expected signature - it would let anyone with log
      // access forge this exact notification.
      await this.dbLogger.error(
        `MD5 signature verification failed for payment_id ${payment_id}, order_id ${order_id}`,
      );
      throw new UnauthorizedException('Md5 verification failed');
    }

    if (!payment_id || !subscription_id || Number(subscription_id) < 0) {
      await this.dbLogger.error(
        `Invalid payment/subscription id: payment_id=${payment_id}, subscription_id=${subscription_id}`,
      );
      throw new BadRequestException('Invalid payment or subscription id');
    }

    const status = this.getPayHereStatusMapped(status_code);
    await this.dbLogger.info(
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
    let createdSubscription: { user_id: string; package_id: string } | null =
      null;
    let subscriptionUserId = '';

    const trx = await this.knexService.knex.transaction();
    try {
      const { subscription, created } = await this.resolveSubscription(trx, {
        subscription_id,
        order_id,
        user_id,
        package_id,
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
          await this.dbLogger.warn(
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

          if (status === 'CHARGEBACK' && current.status !== 'CHARGEBACK') {
            alerts.push(
              current.settled
                ? `CHARGEBACK on settled payment ${payment_id} (sub ${subscription_id}, user ${subscription.user_id}). ${current.satoshis_purchased} sats were already sent - manual reversal needed.`
                : `CHARGEBACK on unsettled payment ${payment_id} (sub ${subscription_id}, user ${subscription.user_id}). It will not be settled.`,
            );
          }

          await this.dbLogger.info(
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

        await this.dbLogger.info(
          `New transaction ${payment_id} created (status ${status})`,
        );
      }

      if (status === 'SUCCESS' && !subscriptionEnded) {
        const activationAlert = await this.activateIfFirstSuccess(
          trx,
          subscription,
          payment_id,
        );
        if (activationAlert) alerts.push(activationAlert);
      }

      await trx.commit();
    } catch (error: unknown) {
      if (!trx.isCompleted()) {
        await trx.rollback();
      }
      await this.dbLogger.error(
        `PayHere notification processing failed for payment_id ${payment_id}: ${error instanceof Error ? error.message : String(error)}`,
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
    for (const alert of alerts) {
      await this.dbLogger.error(alert);
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
   * Binds the subscription to its PayHere order_id (which IS covered by the
   * md5sig) and rejects notifications whose unsigned fields don't match.
   */
  private async resolveSubscription(
    trx: Knex.Transaction,
    params: {
      subscription_id: string;
      order_id: string;
      user_id?: string;
      package_id?: string;
      status: Status;
    },
  ): Promise<{ subscription: Subscription; created: boolean }> {
    const { subscription_id, order_id, user_id, package_id, status } = params;

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
      if (user_id && user_id !== existing.user_id) {
        throw new BadRequestException(
          'custom_1 (user) does not match the subscription',
        );
      }
      if (!existing.payhere_order_id) {
        await this.assertOrderIdUnused(trx, order_id, subscription_id);
        await trx('subscription')
          .update({ payhere_order_id: order_id })
          .where('payhere_sub_id', subscription_id);
        existing.payhere_order_id = order_id;
      }
      return { subscription: existing, created: false };
    }

    if (!user_id || !package_id) {
      throw new BadRequestException(
        `Cannot create subscription ${subscription_id}: missing user_id or package_id`,
      );
    }
    await this.assertOrderIdUnused(trx, order_id, subscription_id);

    const subscription: Subscription = {
      payhere_sub_id: subscription_id,
      payhere_order_id: order_id,
      user_id,
      package_id,
      // Only a paid first charge makes the subscription active
      is_active: status === 'SUCCESS',
    } as Subscription;
    await trx('subscription').insert(subscription);

    await this.dbLogger.info(
      `Created subscription ${subscription_id} for user ${user_id}, package ${package_id} (active: ${subscription.is_active})`,
    );
    return { subscription, created: true };
  }

  private async assertOrderIdUnused(
    trx: Knex.Transaction,
    order_id: string,
    subscription_id: string,
  ): Promise<void> {
    const other = await trx('subscription')
      .where('payhere_order_id', order_id)
      .whereNot('payhere_sub_id', subscription_id)
      .first();
    if (other) {
      throw new BadRequestException(
        'order_id is already bound to another subscription',
      );
    }
  }

  /**
   * A subscription created from a failed/pending first charge starts inactive.
   * Activate it on its first SUCCESS - but never re-activate a cancelled one
   * (those already had a SUCCESS) and never create a second active plan.
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

    const otherActive = await trx('subscription')
      .where('user_id', subscription.user_id)
      .where('is_active', true)
      .whereNot('payhere_sub_id', subscription.payhere_sub_id)
      .first();
    if (otherActive) {
      return `Subscription ${subscription.payhere_sub_id} got its first SUCCESS (${payment_id}) but user ${subscription.user_id} already has active subscription ${otherActive.payhere_sub_id}. Left inactive - check for a double subscription.`;
    }

    await trx('subscription')
      .update({ is_active: true, updated_at: trx.fn.now() })
      .where('payhere_sub_id', subscription.payhere_sub_id);
    await this.dbLogger.info(
      `Subscription ${subscription.payhere_sub_id} activated by first successful payment ${payment_id}`,
    );
    return null;
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
      await this.dbLogger.warn(
        `Failed to log subscription creation to Telegram: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async fetchBitcoinDataForTransaction(
    amount: number,
    currency: string,
  ): Promise<BitcoinData | null> {
    try {
      if (process.env.ENABLE_BITCOIN_TRACKING === 'false') {
        await this.dbLogger.info(
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
        await this.dbLogger.warn(
          `Failed to fetch Bitcoin price for ${netAmount} ${currency} - will be backfilled later`,
        );
        return null;
      }

      await this.dbLogger.info(
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
      await this.dbLogger.error(
        `Error fetching Bitcoin data for transaction (${amount} ${currency}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * SUCCESS payments saved without price data (price API was down at webhook
   * time) are never settled. Fill them in with the current price.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async backfillMissingBitcoinData(): Promise<void> {
    if (process.env.ENABLE_BITCOIN_TRACKING === 'false') return;

    try {
      const rows = await this.knexService
        .knex('transaction as t')
        .select(
          't.payhere_pay_id',
          't.gross_amount',
          'p.amount as package_amount',
          'p.currency as package_currency',
          's.user_id',
        )
        .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
        .join('package as p', 's.package_id', 'p.id')
        .where('t.status', 'SUCCESS')
        .whereNull('t.satoshis_purchased')
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
          await this.dbLogger.warn(
            `Backfilled Bitcoin data for ${row.payhere_pay_id}: ${data.satoshis_purchased} sats at ${data.btc_price_at_purchase} (price taken at backfill time)`,
          );
          await this.invalidateUserCaches(row.user_id);
        }
      }
    } catch (error: unknown) {
      await this.dbLogger.error(
        `Bitcoin data backfill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getTransactionsByUserIdPaginated(
    user_id: string,
    page: number,
    limit: number,
  ): Promise<PaginatedTransactions> {
    const cacheKey = CacheKeys.transaction.list(user_id, page, limit);
    const cached = await this.redisService.get<PaginatedTransactions>(cacheKey);
    if (cached) {
      return cached;
    }

    const subscriptionIds = await this.getSubscriptionIds(user_id);
    if (subscriptionIds.length === 0) {
      const emptyResult: PaginatedTransactions = {
        transactions: [],
        total_count: 0,
        total_pages: 0,
        current_page: page,
        has_more: false,
      };
      await this.redisService.set(cacheKey, emptyResult, { ttl: 120 });
      return emptyResult;
    }

    const [countResult] = await this.knexService
      .knex('transaction')
      .whereIn('payhere_sub_id', subscriptionIds)
      .count<{ count: string }[]>('* as count');

    const totalCount = Number(countResult.count);
    const totalPages = Math.ceil(totalCount / limit);

    // Joined with package info so callers get the LKR amount and plan name
    const transactions = await this.knexService
      .knex('transaction as t')
      .select(
        't.*',
        'p.amount as package_amount',
        'p.currency as package_currency',
        'p.name as package_name',
        'p.frequency as package_frequency',
      )
      .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
      .join('package as p', 's.package_id', 'p.id')
      .whereIn('t.payhere_sub_id', subscriptionIds)
      .orderBy('t.created_at', 'desc')
      .limit(limit)
      .offset((page - 1) * limit);

    const result: PaginatedTransactions = {
      transactions,
      total_count: totalCount,
      total_pages: totalPages,
      current_page: page,
      has_more: page < totalPages,
    };

    await this.redisService.set(cacheKey, result, { ttl: 120 });
    return result;
  }

  async getLatestTransactionForUser(user_id: string): Promise<any | null> {
    const cacheKey = CacheKeys.transaction.latest(user_id);
    const cached = await this.redisService.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const activeSubscription: Subscription | undefined = await this.knexService
      .knex<Subscription>('subscription')
      .where('user_id', user_id)
      .where('is_active', true)
      .orderBy('created_at', 'desc')
      .first();

    if (!activeSubscription) {
      return null;
    }

    const result = await this.knexService
      .knex('transaction as t')
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
        'p.amount as package_amount',
        'p.currency as package_currency',
        'p.name as package_name',
        'p.frequency as package_frequency',
      )
      .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
      .join('package as p', 's.package_id', 'p.id')
      .where('t.payhere_sub_id', activeSubscription.payhere_sub_id)
      .orderBy('t.created_at', 'desc')
      .first();

    if (result) {
      await this.redisService.set(cacheKey, result, { ttl: 60 });
    }
    return result || null;
  }

  async getDCASummaryForUser(user_id: string): Promise<DcaSummary> {
    const cacheKey = CacheKeys.transaction.dcaSummary(user_id);
    const cached = await this.redisService.get<DcaSummary>(cacheKey);
    if (cached) {
      return cached;
    }

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
    let totalSpent = new Big(0); // what the user paid (gross, incl. fees)
    let totalBtcCost = new Big(0); // market value at purchase (for avg price)

    for (const tx of transactions) {
      if (!tx.satoshis_purchased) continue;
      const sats = new Big(tx.satoshis_purchased);
      totalSatoshis = totalSatoshis.plus(sats);

      const btcCost = tx.btc_price_at_purchase
        ? sats.div(SATOSHIS_PER_BTC).times(tx.btc_price_at_purchase)
        : new Big(0);
      totalBtcCost = totalBtcCost.plus(btcCost);
      // Older rows may lack gross_amount - fall back to the BTC cost
      totalSpent = totalSpent.plus(
        tx.gross_amount != null ? new Big(tx.gross_amount) : btcCost,
      );
    }

    const averageBTCPrice =
      totalSatoshis.gt(0) && totalBtcCost.gt(0)
        ? totalBtcCost.div(totalSatoshis.div(SATOSHIS_PER_BTC))
        : new Big(0);

    const market = await this.fetchBalanceAndMarket(user_id);

    const summary: DcaSummary = {
      dca: {
        balance: totalSatoshis.toNumber(),
        spent: totalSpent.toNumber(),
        avg_btc_price: averageBTCPrice.toNumber(),
      },
      currency: 'LKR',
      ...market,
    };

    await this.redisService.set(cacheKey, summary, { ttl: 300 });
    return summary;
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
      await this.dbLogger.warn(
        `Failed to fetch market data for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
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
