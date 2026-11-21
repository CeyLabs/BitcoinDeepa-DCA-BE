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
import { PayHereService, payHereErrorDetail } from '../payhere/payhere.service';
import { PayHereNotificationDto } from './dto/payhere-notification.dto';
import { errorMessage } from '../../common/error-message';
import { computeBuyFees } from '../../common/buy-fees';
import { transferMemo } from '../settlement/transfer-memo';
import { saleCollectMemo, SellStatus } from '../sell/sell.constants';
import {
  BUY_ORDER_EXPIRY_GRACE_MINUTES,
  buyLimits,
  paidOneTimeLkr,
} from '../../common/buy-limits';
import { NOT_IN_HISTORY_SELL_STATUSES } from '../sell/sell.constants';
import {
  toSellOrderView,
  type SellOrderRow,
  type SellOrderView,
} from '../sell/sell.service';

export type PayHereNotificationParams = PayHereNotificationDto;

export type PurchaseKind = 'RECURRING' | 'ONE_TIME';

export type Status =
  | 'SUCCESS'
  | 'PENDING'
  | 'CANCELLED'
  | 'FAILED'
  | 'CHARGEBACK';

export interface Transaction {
  payhere_pay_id: string;
  /** Null for one-time buys */
  payhere_sub_id: string | null;
  kind?: PurchaseKind;
  user_id?: string | null;
  /** One-time buys: the checkout order this payment paid */
  payhere_order_id?: string | null;
  /** Set = settlement skips it until a human releases it */
  hold_reason?: string | null;
  /** The memo its sats are sent with (null = created by an earlier release) */
  transfer_memo?: string | null;
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
  /** False when the BitcoinDeepa wallet balance couldn't be fetched (total_* are then 0, not real) */
  balance_available: boolean;
  currency: string;
  '24_hr_change': number;
  current_btc_price?: {
    usd: number;
    lkr: number;
  };
}

/**
 * One row of the member's history, newest first: a purchase (the
 * `transaction` row with its plan) or a sale (`sell_order`, as the sell
 * endpoints show it).
 */
export type HistoryItem =
  | (Transaction & { type: 'BUY' })
  | { type: 'SELL'; created_at: Date; sell_order: SellOrderView };

export interface PaginatedTransactions {
  transactions: HistoryItem[];
  total_count: number;
  total_pages: number;
  current_page: number;
  has_more: boolean;
}

const SATOSHIS_PER_BTC = 100_000_000;
/** Settlement attempts per payment before it waits for a human */
export const MAX_SETTLEMENT_ATTEMPTS = 5;
/** Longest a /send can be in flight (BITCOINDEEPA_SEND_TIMEOUT 95s) plus margin */
const SEND_IN_FLIGHT_MS = 2 * 60_000;
const DEPOSIT_RESET_THROTTLE_SECONDS = 30;

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

/** Money amounts equal to the cent (PayHere sends e.g. "1000.00"). */
export function sameAmount(a: string | number, b: string | number): boolean {
  const x = Number(String(a).replace(/,/g, ''));
  const y = Number(String(b).replace(/,/g, ''));
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.005;
}

/**
 * PayHere lookups the webhook makes per order_id per hour. A genuine order
 * needs one per notification; beyond this, a signed notification is being
 * replayed, and every lookup spends the API quota settlement depends on.
 */
export const PAYHERE_LOOKUPS_PER_ORDER_PER_HOUR = 10;

/**
 * PayHere's amount ("1000.00") as a number. Parsed as a decimal, not with
 * parseFloat, which stops at the first character it doesn't like
 * ("1,000.00" would be 1). Null when it isn't an amount.
 */
export function parseAmount(value: string | number): number | null {
  try {
    const amount = new Big(String(value).replace(/,/g, '').trim());
    return amount.gte(0) ? amount.toNumber() : null;
  } catch {
    return null;
  }
}

/** Where a payment came from: exactly one of the two is set */
type PaymentLink =
  | { kind: 'RECURRING'; payhere_sub_id: string; payhere_order_id: null }
  | { kind: 'ONE_TIME'; payhere_sub_id: null; payhere_order_id: string };

interface BuyOrderRow {
  order_id: string;
  user_id: string;
  package_id: string | null;
  kind: PurchaseKind;
  amount: string | null;
  currency: string | null;
  expires_at: Date | null;
}

/**
 * A subscription notification for a one-time order: the payer added
 * recurrence fields (not covered by the checkout hash), so PayHere created a
 * subscription. Always rejected. Never cancelled automatically: subscription_id
 * isn't signed, so it could be someone else's; the alert asks a human to check.
 */
class OneTimeOrderAsSubscriptionException extends BadRequestException {
  constructor() {
    super('order_id is a one-time checkout, not a subscription');
  }
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
   * Payments created by an earlier release (no `transfer_memo`) are still sent
   * with that release's memo, `<package> DCA plan (Ref: <id>)`, so the bot
   * recognises a retry of a send it already made.
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

  /** Per-instance fallback for the callback throttle when Redis is down */
  private lastDepositResetAt = 0;

  /**
   * True when the request carries the bot's callback secret, or no secret is
   * configured (the bot can't send one yet). Constant-time compare.
   */
  static isBotCallbackAuthorized(header: string | undefined): boolean {
    const secret = process.env.BITCOINDEEPA_CALLBACK_SECRET;
    if (!secret) return true;
    if (!header) return false;
    const digest = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(digest(header), digest(secret));
  }

  /**
   * The bot's deposit callback (POST /transaction/reset-retry-counts): the
   * DCA wallet got sats, so payments that failed for low wallet balance are
   * retried now. It only skips the backoff and allows at most one more
   * attempt (an exhausted row gets one): it never moves funds, and calling
   * it repeatedly can't keep a payment retrying, because a row only becomes
   * LOW_BALANCE again after another real attempt. Rows attempted in the last
   * 2 min are skipped (their send may be in flight), as are held,
   * awaiting-approval and other failures. Throttled to one reset per 30s
   * across instances, with a per-instance fallback if Redis is down.
   */
  async resetLowBalanceRetries(): Promise<{ reset: number }> {
    const now = Date.now();
    if (now - this.lastDepositResetAt < DEPOSIT_RESET_THROTTLE_SECONDS * 1000) {
      return { reset: 0 };
    }
    if (
      !(await this.redisService.setIfAbsent(
        'dca:bot-deposit-reset',
        DEPOSIT_RESET_THROTTLE_SECONDS,
      ))
    ) {
      return { reset: 0 };
    }
    this.lastDepositResetAt = now;

    const reset = await this.knexService
      .knex('transaction')
      .where({ status: 'SUCCESS', settled: false })
      .whereNull('hold_reason')
      .whereNull('bot_send_id')
      .where('settlement_failure', 'LOW_BALANCE')
      .where((qb) => {
        void qb
          .whereNull('last_retry_at')
          .orWhere('last_retry_at', '<', new Date(now - SEND_IN_FLIGHT_MS));
      })
      .update({
        retry_count: this.knexService.knex.raw('LEAST(retry_count, ?)', [
          MAX_SETTLEMENT_ATTEMPTS - 1,
        ]),
        last_retry_at: null,
        settlement_failure: null,
      });
    if (reset > 0) {
      this.logger.warn(
        `DCA wallet deposit: retrying ${reset} payment(s) that failed for low balance`,
      );
      await this.telegramLoggerService
        .logAlert(
          'Settlement',
          `DCA wallet received sats: retrying ${reset} payout(s) that failed for low wallet balance.`,
        )
        .catch(() => undefined);
    }
    return { reset };
  }

  /**
   * Let settlement pay a held one-time buy, after a human checked it (see
   * oneTimeHoldReason). Separate from resetRetryCount so the log says which
   * decision was made.
   */
  async releaseHold(
    payhere_pay_id: string,
  ): Promise<{ payhere_pay_id: string; hold_reason: string }> {
    const row = await this.knexService.knex.transaction(async (trx) => {
      const held = await trx<Transaction>('transaction')
        .select('hold_reason')
        .where({ payhere_pay_id, settled: false })
        .whereNotNull('hold_reason')
        .forUpdate()
        .first();
      if (!held?.hold_reason) return null;
      await trx('transaction')
        .update({ hold_reason: null })
        .where('payhere_pay_id', payhere_pay_id);
      return { hold_reason: held.hold_reason };
    });
    if (!row) {
      throw new NotFoundException(
        `No held, unsettled transaction with payment_id ${payhere_pay_id}`,
      );
    }
    this.logger.warn(
      `Hold released for ${payhere_pay_id} (was: ${row.hold_reason}) - it will be settled`,
    );
    await this.telegramLoggerService.logAlert(
      'Settlement',
      `Hold released for one-time buy ${payhere_pay_id} (was: ${row.hold_reason}). It will be settled.`,
    );
    return { payhere_pay_id, hold_reason: row.hold_reason };
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
   * payments are refused before anything is recorded (checkWithPayHere), and
   * settlement only pays a payment_id that PayHere's API lists as RECEIVED.
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
   * How long to wait before asking PayHere again when a SUCCESS
   * notification's payment isn't listed yet (its API can lag the
   * notification). Tests shorten it.
   */
  static payHereLookupRetryDelaysMs = [1500, 3000];

  /**
   * Checks a signed notification's payment_id with PayHere before anything is
   * recorded. The md5sig doesn't cover payment_id, and a payer can point the
   * unsigned notify_url at their own server, so a genuine signed notification
   * can be re-posted with invented payment_ids.
   *
   * - A status change of a payment we already recorded (a chargeback, or a
   *   resent SUCCESS): no lookup.
   * - A notification our own records already refuse (unknown order, wrong
   *   amount, order of the other kind): no lookup - handlePayHereNotification
   *   refuses it as before. Only checkouts we created reach PayHere's API.
   * - More than PAYHERE_LOOKUPS_PER_ORDER_PER_HOUR lookups for one order_id:
   *   `throttled`, without calling PayHere (replays must not use up our API
   *   quota: settlement needs it to pay anyone).
   * - SUCCESS that PayHere lists for another amount, or (after the retries)
   *   with a status other than RECEIVED: `reject` - PayHere won't change its
   *   mind.
   * - SUCCESS not listed yet after the retries: `process`. PayHere's list can
   *   lag, and refusing would lose a real payment; settlement pays only once
   *   PayHere lists it (isConfirmedByPayHere), so a replay is still never
   *   paid.
   * - Another status for a payment_id we don't have and PayHere doesn't list:
   *   `ignore` (nothing to record, nothing it could pay out).
   * - The lookup itself failing: `process`, for the same reason.
   */
  async checkWithPayHere(data: PayHereNotificationParams): Promise<{
    action: 'process' | 'ignore' | 'reject' | 'throttled';
    reason?: string;
    /** recorded although PayHere didn't list it (yet) */
    unconfirmed?: boolean;
  }> {
    const { payment_id, order_id, subscription_id, payhere_amount } = data;
    if (!payment_id) return { action: 'process' }; // refused later as invalid
    const success = this.getPayHereStatusMapped(data.status_code) === 'SUCCESS';

    const known = await this.knexService
      .knex<Transaction>('transaction')
      .select('status')
      .where('payhere_pay_id', payment_id)
      .first();
    if (known && (!success || known.status === 'SUCCESS')) {
      return { action: 'process' };
    }

    if (!(await this.matchesOurCheckout(data))) return { action: 'process' };

    const lookups = await this.redisService.incrWithTtl(
      CacheKeys.payhere.lookups(order_id),
      60 * 60,
    );
    if (lookups !== null && lookups > PAYHERE_LOOKUPS_PER_ORDER_PER_HOUR) {
      return {
        action: 'throttled',
        reason: `more than ${PAYHERE_LOOKUPS_PER_ORDER_PER_HOUR} PayHere lookups for order ${order_id} in the last hour`,
      };
    }

    const delays = success ? TransactionService.payHereLookupRetryDelaysMs : [];
    let reason = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
      const last = attempt === delays.length;
      let payment: Awaited<ReturnType<PayHereService['findPayment']>>;
      try {
        // The Retrieval API lists a subscription's charges under its order_id;
        // the Subscription Manager is asked too, on the last try only
        payment = await this.payHereService.findPayment(
          payment_id,
          order_id,
          last ? subscription_id || null : null,
        );
      } catch (error) {
        this.logger.warn(
          `PayHere lookup for notification payment_id ${payment_id} failed (${payHereErrorDetail(error)}); recording it, settlement checks it again before paying`,
        );
        return { action: 'process', unconfirmed: true };
      }

      if (!success) {
        return payment
          ? { action: 'process' }
          : {
              action: 'ignore',
              reason: `payment ${payment_id} is not listed by PayHere`,
            };
      }
      if (!payment) {
        reason = `payment ${payment_id} is not listed by PayHere`;
        continue;
      }
      if (
        payment.amount !== null &&
        payhere_amount !== undefined &&
        !sameAmount(payment.amount, payhere_amount)
      ) {
        // The signed amount can't change, so PayHere won't change its mind
        return {
          action: 'reject',
          reason: `PayHere lists payment ${payment_id} for ${payment.amount}, not ${payhere_amount}`,
        };
      }
      if (payment.status !== 'RECEIVED') {
        reason = `PayHere lists payment ${payment_id} as ${payment.status}, not RECEIVED`;
        if (last) return { action: 'reject', reason };
        continue;
      }
      return { action: 'process' };
    }
    // Not listed yet: record it, settlement pays only once PayHere lists it
    this.logger.warn(
      `Recording payment_id ${payment_id} (order ${order_id}) unconfirmed: ${reason} yet. Settlement pays it only once PayHere does.`,
    );
    return { action: 'process', reason, unconfirmed: true };
  }

  /**
   * The cheap checks handlePayHereNotification makes anyway, read-only and
   * before any PayHere call: the order is a checkout we created, of the
   * notification's kind; a one-time order's signed amount and currency are
   * the order's; an existing subscription is bound to this order. False means
   * the notification will be refused without asking PayHere.
   */
  private async matchesOurCheckout({
    order_id,
    subscription_id,
    payhere_amount,
    payhere_currency,
  }: PayHereNotificationParams): Promise<boolean> {
    const order = await this.knexService
      .knex<BuyOrderRow>('buy_order')
      .where('order_id', order_id)
      .first();
    if (!order) return false;
    if (!subscription_id) {
      return (
        order.kind === 'ONE_TIME' &&
        order.amount !== null &&
        sameAmount(order.amount, payhere_amount) &&
        order.currency === payhere_currency
      );
    }
    if (order.kind !== 'RECURRING') return false;
    const sub = await this.knexService
      .knex<Subscription>('subscription')
      .select('user_id', 'payhere_order_id')
      .where('payhere_sub_id', subscription_id)
      .first();
    if (!sub) return true;
    return sub.payhere_order_id
      ? sub.payhere_order_id === order_id
      : sub.user_id === order.user_id;
  }

  /**
   * Alert about a refused or throttled notification, at most a few times per
   * order_id per hour: replays of one signed notification must not flood the
   * alert topic. Alerts on the 1st, 10th, 100th... refusal in the window, with
   * the count.
   */
  async alertRefusedNotification(
    order_id: string,
    message: string,
  ): Promise<void> {
    const count = await this.redisService.incrWithTtl(
      CacheKeys.payhere.refusedAlerts(order_id),
      60 * 60,
    );
    if (count !== null && !/^10*$/.test(String(count))) return;
    const repeat =
      count !== null && count > 1
        ? ` This is refusal #${count} for order ${order_id} in the last hour (alerts are sent at the 1st, 10th, 100th...).`
        : '';
    await this.telegramLoggerService
      .logAlert('PayHere webhook', message + repeat)
      .catch(() => undefined);
  }

  /**
   * Who a notification's payment belongs to, from our own records (never
   * custom_1). For logging; resolveSubscription is what actually decides.
   */
  async getNotificationOwner(
    order_id: string,
    subscription_id: string | undefined,
  ): Promise<string | null> {
    if (subscription_id) {
      const sub = await this.knexService
        .knex<Subscription>('subscription')
        .select('user_id')
        .where('payhere_sub_id', subscription_id)
        .first();
      if (sub) return sub.user_id;
    }
    const order = await this.knexService
      .knex<{ order_id: string; user_id: string }>('buy_order')
      .select('user_id')
      .where('order_id', order_id)
      .first();
    return order?.user_id ?? null;
  }

  /**
   * Record a PayHere notification: a subscription charge, or a one-off
   * checkout (one-time buy, no subscription_id). The caller must have checked
   * isValidPayHereSignature first (the controller does, before anything is
   * logged).
   *
   * Both kinds share the payment rules (upsertPayment): the signed order_id
   * decides the owner, statuses only move forward, pricing at SUCCESS. Only
   * finding the payment's source and what follows a SUCCESS differ.
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

    const oneTime = !subscription_id;
    if (!payment_id || (!oneTime && Number(subscription_id) < 0)) {
      this.logger.error(
        `Invalid payment/subscription id: payment_id=${payment_id}, subscription_id=${subscription_id}`,
      );
      throw new BadRequestException('Invalid payment or subscription id');
    }

    const grossAmount = parseAmount(payhere_amount);
    if (grossAmount === null) {
      this.logger.error(
        `Invalid amount for payment_id ${payment_id}: ${payhere_amount}`,
      );
      throw new BadRequestException('Invalid payment amount');
    }

    const status = this.getPayHereStatusMapped(status_code);
    this.logger.log(
      `Processing PayHere ${oneTime ? 'one-time' : 'subscription'} notification: payment_id=${payment_id}, order_id=${order_id}, subscription_id=${subscription_id ?? '-'}, status=${status}, amount=${payhere_amount} ${payhere_currency}`,
    );

    const bitcoinData = await this.priceIfNeeded(
      payment_id,
      status,
      grossAmount,
      payhere_currency,
    );

    // PayHere stopped (retries exhausted / cancelled) or completed the plan
    const subscriptionEnded =
      !oneTime &&
      (item_rec_status === '-1' ||
        item_rec_status === '1' ||
        message_type === 'RECURRING_STOPPED' ||
        message_type === 'RECURRING_COMPLETE');

    const alerts: string[] = [];
    let userId = '';
    let duplicate: { payhere_sub_id: string; activeSubId: string } | null =
      null;
    let createdSubscription: { user_id: string; package_id: string } | null =
      null;

    const trx = await this.knexService.knex.transaction();
    try {
      let link: PaymentLink;
      let subscription: Subscription | null = null;
      let order: BuyOrderRow | null = null;

      if (oneTime) {
        order = await this.resolveOneTimeOrder(trx, data);
        userId = order.user_id;
        // Payments of the same member run one after another, so the hold
        // checks (paid twice, 24h limit) always see each other's rows. NO KEY
        // UPDATE: compatible with the FK share lock an insert takes, like
        // the link endpoint and activateIfFirstSuccess.
        await trx('user').where('id', userId).forNoKeyUpdate().first();
        link = {
          kind: 'ONE_TIME',
          payhere_sub_id: null,
          payhere_order_id: order_id,
        };
      } else {
        const resolved = await this.resolveSubscription(trx, {
          subscription_id,
          order_id,
          status,
        });
        subscription = resolved.subscription;
        userId = subscription.user_id;
        if (resolved.created) {
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
            `PayHere ended subscription ${subscription_id} (user ${userId}): message_type=${message_type ?? '-'}, item_rec_status=${item_rec_status ?? '-'}. Marked inactive.`,
          );
        }
        link = {
          kind: 'RECURRING',
          payhere_sub_id: subscription_id,
          payhere_order_id: null,
        };
      }

      // Set when this notification is what made the payment SUCCESS (a
      // resent SUCCESS must not re-activate a plan the user has since
      // cancelled, or re-raise the paid-twice alert).
      const { becameSuccess } = await this.upsertPayment(trx, {
        payment_id,
        status,
        gross_amount: grossAmount,
        bitcoinData,
        user_id: userId,
        link,
        alerts,
      });

      if (becameSuccess && subscription && !subscriptionEnded) {
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
      if (becameSuccess && order) {
        const holdReason = await this.oneTimeHoldReason(trx, order, payment_id);
        if (holdReason) {
          await trx('transaction')
            .update({ hold_reason: holdReason })
            .where('payhere_pay_id', payment_id);
          alerts.push(
            `One-time buy ${payment_id} (order ${order_id}, user ${userId}, ${payhere_amount} ${payhere_currency}) is HELD, not settled: ${holdReason}. ` +
              `Check it, then release it with POST /transaction/release-hold/${payment_id}, or refund it in PayHere.`,
          );
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
        let extra = '';
        if (error instanceof OneTimeOrderAsSubscriptionException) {
          extra = ` If PayHere shows subscription ${subscription_id ?? '-'} was created from this one-time checkout, cancel it and refund the charge in PayHere (subscription_id isn't signed: check before acting).`;
        }
        await this.telegramLoggerService.logAlert(
          'PayHere webhook',
          `Rejected signed notification payment_id=${payment_id}, order_id=${order_id}, subscription_id=${subscription_id ?? '-'}: ${errorMessage(error)}.${extra}`,
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
          userId,
        ),
      );
    }
    for (const alert of alerts) {
      this.logger.error(alert);
      await this.telegramLoggerService.logAlert('PayHere webhook', alert);
    }
    await this.invalidateUserCaches(userId);
  }

  /**
   * Why a one-time payment that just became SUCCESS must not be settled
   * automatically, or null. The link endpoint enforces the limits, but a
   * PayHere checkout can't expire and can be paid more than once, so they're
   * checked again here. Held payments are recorded (the member did pay) and
   * wait for a human.
   */
  private async oneTimeHoldReason(
    trx: Knex.Transaction,
    order: BuyOrderRow,
    payment_id: string,
  ): Promise<string | null> {
    const reasons: string[] = [];

    const otherPaid = await trx<Transaction>('transaction')
      .where('payhere_order_id', order.order_id)
      .whereNot('payhere_pay_id', payment_id)
      .whereIn('status', ['SUCCESS', 'CHARGEBACK'])
      .first();
    if (otherPaid) {
      reasons.push(
        `order was already paid by ${otherPaid.payhere_pay_id} (paid twice)`,
      );
    }

    if (order.expires_at) {
      const late =
        Date.now() -
        new Date(order.expires_at).getTime() -
        BUY_ORDER_EXPIRY_GRACE_MINUTES * 60_000;
      if (late > 0) {
        reasons.push(
          `paid after the checkout expired at ${new Date(order.expires_at).toISOString()}`,
        );
      }
    }

    // Includes this payment (already written in this transaction)
    const paid = await paidOneTimeLkr(trx, order.user_id);
    const max = buyLimits.dailyMaxLkr();
    if (paid > max) {
      reasons.push(
        `member's one-time buys in 24h are ${paid} LKR, over the ${max} LKR limit`,
      );
    }

    return reasons.length ? reasons.join('; ') : null;
  }

  /**
   * BTC price data for a SUCCESS that isn't priced yet. Fetched before the DB
   * transaction opens, to keep that short.
   */
  private async priceIfNeeded(
    payment_id: string,
    status: Status,
    amount: number,
    currency: string,
  ): Promise<BitcoinData | null> {
    if (status !== 'SUCCESS') return null;
    const existing = await this.knexService
      .knex<Transaction>('transaction')
      .where('payhere_pay_id', payment_id)
      .first();
    if (
      existing &&
      (existing.status === 'CHARGEBACK' || existing.satoshis_purchased)
    ) {
      return null;
    }
    return this.fetchBitcoinDataForTransaction(amount, currency, payment_id);
  }

  /**
   * The ONE_TIME order a one-off notification pays. Its order_id and amount
   * are signed, so the order must exist, be one-time, and be for exactly the
   * signed amount.
   */
  private async resolveOneTimeOrder(
    trx: Knex.Transaction,
    { order_id, payhere_amount, payhere_currency }: PayHereNotificationParams,
  ): Promise<BuyOrderRow> {
    const order = await trx<BuyOrderRow>('buy_order')
      .where('order_id', order_id)
      .first();
    if (!order) {
      throw new BadRequestException(
        `Unknown order_id ${order_id} - no checkout link was generated for it`,
      );
    }
    if (order.kind !== 'ONE_TIME') {
      // A subscription checkout whose recurrence fields were stripped
      throw new BadRequestException(
        `order_id ${order_id} is a subscription checkout but the notification has no subscription_id`,
      );
    }
    if (
      order.amount === null ||
      !sameAmount(order.amount, payhere_amount) ||
      order.currency !== payhere_currency
    ) {
      throw new BadRequestException(
        `Amount ${payhere_amount} ${payhere_currency} does not match order ${order_id} (${order.amount} ${order.currency})`,
      );
    }
    return order;
  }

  /**
   * Insert or update the payment row, the same for both kinds. The row is
   * locked; a payment_id already recorded for another subscription/order is
   * refused, and status changes follow isAllowedTransition.
   */
  private async upsertPayment(
    trx: Knex.Transaction,
    p: {
      payment_id: string;
      status: Status;
      gross_amount: number;
      bitcoinData: BitcoinData | null;
      user_id: string;
      link: PaymentLink;
      alerts: string[];
    },
  ): Promise<{ becameSuccess: boolean }> {
    const { payment_id, status, bitcoinData, link } = p;
    const source =
      link.kind === 'ONE_TIME'
        ? `order ${link.payhere_order_id}`
        : `sub ${link.payhere_sub_id}`;

    const current = await trx<Transaction>('transaction')
      .where('payhere_pay_id', payment_id)
      .forUpdate()
      .first();

    if (!current) {
      const row: Transaction = {
        payhere_pay_id: payment_id,
        ...link,
        user_id: p.user_id,
        status,
        retry_count: 0,
        gross_amount: p.gross_amount,
        // Fixed for the life of the payment: it is the bot's idempotency key
        transfer_memo: transferMemo(payment_id, link.kind),
        ...(bitcoinData ?? {}),
      };
      await trx('transaction').insert(row);
      this.logger.log(
        `New ${link.kind} transaction ${payment_id} created (${source}, status ${status})`,
      );
      return { becameSuccess: status === 'SUCCESS' };
    }

    // Rows from before kinds existed are RECURRING with no order id
    if (
      (current.kind ?? 'RECURRING') !== link.kind ||
      current.payhere_sub_id !== link.payhere_sub_id ||
      (current.payhere_order_id ?? null) !== link.payhere_order_id
    ) {
      throw new BadRequestException(
        link.kind === 'ONE_TIME'
          ? 'payment_id belongs to a different order'
          : 'payment_id belongs to a different subscription',
      );
    }

    if (!this.isAllowedTransition(current.status, status)) {
      this.logger.warn(
        `Ignoring status change ${current.status} → ${status} for payment_id ${payment_id} (out-of-order or duplicate notification)`,
      );
      return { becameSuccess: false };
    }

    const update: Partial<Transaction> = { status };
    if (bitcoinData && !current.satoshis_purchased) {
      Object.assign(update, bitcoinData);
    }
    await trx('transaction').update(update).where('payhere_pay_id', payment_id);

    if (status === 'CHARGEBACK' && current.status !== 'CHARGEBACK') {
      const what = link.kind === 'ONE_TIME' ? 'one-time buy' : 'payment';
      p.alerts.push(
        current.settled
          ? `CHARGEBACK on settled ${what} ${payment_id} (${source}, user ${p.user_id}). ${current.satoshis_purchased} sats were already sent - manual reversal needed.`
          : `CHARGEBACK on unsettled ${what} ${payment_id} (${source}, user ${p.user_id}). It will not be settled.`,
      );
    }
    this.logger.log(
      `Transaction ${payment_id} updated: ${current.status} → ${status}`,
    );
    return {
      becameSuccess: status === 'SUCCESS' && current.status !== 'SUCCESS',
    };
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
   * the md5sig, and the user/package come from the buy_order row we stored
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
        // wrong order. Every order since binding has a buy_order row, so
        // it must belong to this subscription's user. Old orders have no row
        // and only arrive as genuine renewals.
        const order = await trx<{ user_id: string; kind: PurchaseKind }>(
          'buy_order',
        )
          .select('user_id', 'kind')
          .where('order_id', order_id)
          .first();
        if (order?.kind === 'ONE_TIME') {
          throw new OneTimeOrderAsSubscriptionException();
        }
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

    const order = await trx<BuyOrderRow>('buy_order')
      .where('order_id', order_id)
      .first();
    if (!order) {
      throw new BadRequestException(
        `Unknown order_id ${order_id} - no checkout link was generated for it`,
      );
    }
    // A one-time checkout with recurrence fields added by the payer would
    // otherwise become a subscription with no package
    if (order.kind !== 'RECURRING' || !order.package_id) {
      throw new OneTimeOrderAsSubscriptionException();
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

  /**
   * Price data for a payment. `coingecko_timestamp` is when the price was
   * taken: now for a live price, or the exchange_rate_log row's created_at
   * when the live price was down and the logged rate was used (then it is
   * earlier than the payment, and the log line below names the row).
   */
  private async fetchBitcoinDataForTransaction(
    amount: number,
    currency: string,
    paymentId: string,
  ): Promise<BitcoinData | null> {
    try {
      if (process.env.ENABLE_BITCOIN_TRACKING === 'false') {
        this.logger.log(
          'Bitcoin tracking is disabled - skipping Bitcoin data fetch',
        );
        return null;
      }

      const fees = computeBuyFees(amount);
      const netAmount = fees.net;

      const calc = await this.bitcoinPriceService.calculateSatoshis(
        netAmount,
        currency,
      );
      if (!calc) {
        this.logger.warn(
          `Failed to fetch Bitcoin price for ${paymentId} (${netAmount} ${currency}) - will be backfilled later`,
        );
        return null;
      }

      const calculation = `Bitcoin buy calculation for ${paymentId}: ${amount} ${currency} gross, ${fees.totalFees} fees, ${netAmount} net = ${calc.satoshis} sats at ${calc.btc_price} ${currency}/BTC`;
      if (calc.source === 'log') {
        // Not the live price: keep this findable if the member disputes it
        this.logger.warn(
          `${calculation} (live price unavailable: exchange_rate_log #${calc.rate_log_id}, logged at ${calc.priced_at.toISOString()})`,
        );
      } else {
        this.logger.log(`${calculation} (live price)`);
      }

      return {
        btc_price_at_purchase: calc.btc_price,
        satoshis_purchased: calc.satoshis,
        price_currency: calc.currency,
        coingecko_timestamp: calc.priced_at,
        gross_amount: amount,
        payment_processor_fee_basis_points: fees.paymentProcessorFeeBps,
        payment_processor_fee_amount: fees.paymentProcessorFee,
        bitcoindeepa_fee_basis_points: fees.bitcoindeepaFeeBps,
        bitcoindeepa_fee_amount: fees.bitcoindeepaFee,
        net_amount: netAmount,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Error fetching Bitcoin data for ${paymentId} (${amount} ${currency}): ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Settlement and history find a payment's owner through transaction.user_id.
   * During a deploy, an instance still running the previous build can insert
   * plan charges without it; copy it from their subscription so they're
   * settled and shown. A no-op once every instance runs this build.
   *
   * TODO: remove after the one-time-buy release has rolled out everywhere.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async fillMissingTransactionOwners(): Promise<void> {
    try {
      const result: { rowCount?: number } = await this.knexService.knex.raw(`
        UPDATE "transaction" t
           SET user_id = s.user_id
          FROM subscription s
         WHERE t.user_id IS NULL
           AND s.payhere_sub_id = t.payhere_sub_id
           AND s.user_id IS NOT NULL
      `);
      if (result.rowCount) {
        this.logger.warn(
          `Filled the owner of ${result.rowCount} transaction(s) from their subscription`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `Filling transaction owners failed: ${errorMessage(error)}`,
      );
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
          this.knexService.knex.raw(
            "coalesce(p.currency, o.currency, 'LKR') as currency",
          ),
          't.user_id',
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
          row.currency,
          row.payhere_pay_id,
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
            `Backfilled Bitcoin data for ${row.payhere_pay_id}: ${data.satoshis_purchased} sats at ${data.btc_price_at_purchase} (priced by the backfill, not at payment time; price as of ${data.coingecko_timestamp?.toISOString()})`,
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
    const knex = this.knexService.knex;
    // Purchases and sales as one list, so a page is cut across both
    const feed = () =>
      knex.from(
        knex('transaction')
          .select(
            knex.raw("'BUY' as type"),
            'payhere_pay_id as id',
            'created_at',
          )
          .where('user_id', user_id)
          .unionAll(
            knex('sell_order')
              .select(
                knex.raw("'SELL' as type"),
                knex.raw('id::text as id'),
                'created_at',
              )
              .where('user_id', user_id)
              .whereNotIn('status', NOT_IN_HISTORY_SELL_STATUSES),
          )
          .as('feed'),
      );

    const [countResult] = await feed().count<{ count: string }[]>('* as count');
    const totalCount = Number(countResult.count);
    const totalPages = Math.ceil(totalCount / limit);

    const pageRows = await feed()
      .select<{ type: 'BUY' | 'SELL'; id: string }[]>('type', 'id')
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit)
      .offset((page - 1) * limit);
    const idsOf = (type: 'BUY' | 'SELL') =>
      pageRows.filter((r) => r.type === type).map((r) => r.id);

    // Joined with package info so callers get the LKR amount and plan name
    // (null for one-time buys - see kind)
    const buyIds = idsOf('BUY');
    const buys: Transaction[] =
      buyIds.length === 0
        ? []
        : ((await this.transactionsWithPackage()
            .select('t.*', ...PACKAGE_COLUMNS)
            .where('t.user_id', user_id)
            .whereIn('t.payhere_pay_id', buyIds)) as Transaction[]);
    const sellIds = idsOf('SELL');
    const sells =
      sellIds.length === 0
        ? []
        : await knex<SellOrderRow>('sell_order')
            .where('user_id', user_id)
            .whereIn('id', sellIds);

    const buyById = new Map(buys.map((b) => [b.payhere_pay_id, b]));
    const sellById = new Map(sells.map((s) => [s.id, s]));
    const transactions: HistoryItem[] = [];
    for (const { type, id } of pageRows) {
      if (type === 'BUY') {
        const buy = buyById.get(id);
        if (buy) transactions.push({ type: 'BUY', ...buy });
        continue;
      }
      const sell = sellById.get(id);
      if (sell) {
        transactions.push({
          type: 'SELL',
          created_at: sell.created_at,
          sell_order: toSellOrderView(sell),
        });
      }
    }

    return {
      transactions,
      total_count: totalCount,
      total_pages: totalPages,
      current_page: page,
      has_more: page < totalPages,
    };
  }

  /**
   * Marks the bot-history rows that are a purchase's settlement transfer
   * (memo "... (Ref: <payment id>)", amount = its sats), so the app shows that
   * purchase once. Memos are free text, so the ref must be one of the user's
   * own SUCCESS payments and the amount must match. Left unmarked, so the
   * transfer stays the record that the sats arrived:
   * - a charged-back purchase (its row reads as not credited);
   * - a successful transfer for a purchase not marked settled (an unknown
   *   send outcome: the purchase still reads as "Processing").
   */
  async markPurchaseSettlements<
    T extends {
      direction: string;
      memo?: string;
      amount: number;
      success: boolean;
      payment_hash?: string;
    },
  >(
    userId: string,
    rows: T[],
  ): Promise<(T & { purchase_settlement: boolean })[]> {
    const refOf = (row: T) =>
      row.direction === 'incoming'
        ? TransactionService.SETTLEMENT_REF.exec(row.memo ?? '')?.[1]
        : undefined;
    const refs = [...new Set(rows.map(refOf).filter((r): r is string => !!r))];
    const purchases = new Map<string, SettledPurchase>();
    if (refs.length > 0) {
      const found = await this.knexService
        .knex('transaction')
        .where('user_id', userId)
        .where('status', 'SUCCESS')
        .whereIn('payhere_pay_id', refs)
        .select<
          {
            payhere_pay_id: string;
            settled: boolean;
            satoshis_purchased: string | number | null;
            bot_payment_hash: string | null;
          }[]
        >('payhere_pay_id', 'settled', 'satoshis_purchased', 'bot_payment_hash');
      for (const p of found) {
        purchases.set(p.payhere_pay_id, {
          settled: p.settled,
          sats: Number(p.satoshis_purchased),
          paymentHash: p.bot_payment_hash,
        });
      }
    }
    return rows.map((row) => {
      const ref = refOf(row);
      const p = ref === undefined ? undefined : purchases.get(ref);
      return {
        ...row,
        purchase_settlement: !!p && isPurchaseSettlement(row, p),
      };
    });
  }

  private static readonly SETTLEMENT_REF = /\(Ref: ([^)]+)\)$/;

  /**
   * Adds the other party's Bitcoin Deepa @username and avatar seed to each
   * bot-history row (null when they haven't claimed one or aren't a member),
   * so the app labels transfers with our usernames, not Telegram's.
   */
  async markCounterparties<
    T extends { direction: string; from_id: number; to_id: number },
  >(
    rows: T[],
  ): Promise<
    (T & {
      counterparty_username: string | null;
      counterparty_avatar_seed: string | null;
    })[]
  > {
    const other = (row: T) =>
      String(row.direction === 'outgoing' ? row.to_id : row.from_id);
    const ids = [...new Set(rows.map(other))];
    const members =
      ids.length === 0
        ? []
        : await this.knexService
            .knex('user')
            .whereIn('id', ids)
            .whereNotNull('username')
            .select<
              { id: string; username: string; avatar_seed: string | null }[]
            >('id', 'username', 'avatar_seed');
    const byId = new Map(members.map((m) => [m.id, m]));
    return rows.map((row) => {
      const m = byId.get(other(row));
      return {
        ...row,
        counterparty_username: m?.username ?? null,
        counterparty_avatar_seed: m?.avatar_seed ?? null,
      };
    });
  }

  /**
   * Marks the bot-history rows that are a sale's payment (the user's approved
   * collect request), so the app shows that sale once, and says which sale
   * (`sale_order_id`) so it can show the transfer's memo on it. Matched against
   * the user's own sell orders whose sats left their wallet, by
   * matchSalePayments. Left unmarked: a refunded sale's payment (it nets out
   * with the refund, which is listed too) and anything that doesn't match.
   */
  async markSalePayments<T extends SaleMatchRow>(
    userId: string,
    rows: T[],
  ): Promise<(T & { sale_payment: boolean; sale_order_id: string | null })[]> {
    const amounts = [
      ...new Set(
        rows
          .filter((r) => r.direction === 'outgoing' && r.success)
          .map((r) => Number(r.amount)),
      ),
    ];
    const orders =
      amounts.length === 0
        ? []
        : await this.knexService
            .knex('sell_order')
            .where('user_id', userId)
            .whereIn('status', SALE_PAID_STATUSES)
            .whereIn('sats', amounts)
            .select<
              SaleMatchOrder[]
            >('id', 'sats', 'amount_lkr', 'created_at', 'bot_payment_hash');
    const paid = matchSalePayments(rows, orders);
    return rows.map((row, i) => ({
      ...row,
      sale_payment: paid.has(i),
      sale_order_id: paid.get(i) ?? null,
    }));
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
    const key = CacheKeys.transaction.dcaSummary(user_id);
    const cached = await this.redisService.get<DcaSummary>(key);
    if (cached) return cached;
    const summary = await this.computeDcaSummary(user_id);
    // A missing wallet balance is retried soon instead of sticking for 5 min
    await this.redisService.set(key, summary, {
      ttl: summary.balance_available ? 300 : 30,
    });
    return summary;
  }

  private async computeDcaSummary(user_id: string): Promise<DcaSummary> {
    // Subscription charges and one-time buys alike
    const transactions: Transaction[] = await this.knexService
      .knex<Transaction>('transaction')
      .where('user_id', user_id)
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

  /**
   * transaction t → subscription s → package p, and the checkout order o.
   * Left joins: one-time buys have no subscription or package.
   */
  private transactionsWithPackage() {
    return this.knexService
      .knex('transaction as t')
      .leftJoin('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
      .leftJoin('package as p', 's.package_id', 'p.id')
      .leftJoin('buy_order as o', 't.payhere_order_id', 'o.order_id');
  }

  /** Wallet balance (BitcoinDeepa) + BTC price and 24h change. Never throws. */
  private async fetchBalanceAndMarket(
    user_id: string,
  ): Promise<Omit<DcaSummary, 'dca' | 'currency'>> {
    let total_balance = 0;
    let total_lkr = '0.00';
    let balance_available = false;
    if (this.bitcoinDeepaService.isConfigured()) {
      const balance = await this.bitcoinDeepaService.getUserBalance(
        parseInt(user_id, 10),
      );
      if (balance.success) {
        total_balance = balance.balance ?? 0;
        total_lkr = balance.balance_lkr ?? '0.00';
        balance_available = true;
      }
    }

    // Neither throws; null when unavailable. The 24h change (CoinMarketCap)
    // is display only - the price itself is Ceylon Cash × CeyPay.
    const [rate, change24h] = await Promise.all([
      this.bitcoinPriceService.getBtcLkrRate(),
      this.bitcoinPriceService.getBitcoin24HrChange(),
    ]);

    return {
      total_balance,
      total_lkr,
      balance_available,
      '24_hr_change': change24h ?? 0,
      current_btc_price: rate
        ? { usd: rate.btcUsd, lkr: rate.btcLkr }
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

/** Sell statuses whose sats may have left the user's wallet (not refunded) */
const SALE_PAID_STATUSES: SellStatus[] = [
  SellStatus.COLLECTING,
  SellStatus.SATS_COLLECTED,
  SellStatus.PAYOUT_PENDING,
  SellStatus.COMPLETED,
  SellStatus.REFUNDING,
  SellStatus.NEEDS_REVIEW,
];

export interface SettledPurchase {
  settled: boolean;
  sats: number;
  /** The settling transfer's hash, once known (transaction.bot_payment_hash) */
  paymentHash?: string | null;
}

/**
 * Is this bot-history row (already found by its "(Ref: <payment id>)" memo)
 * the transfer that settled that purchase? Same sats, and:
 * - a successful row: the purchase is settled, and when its transfer's hash is
 *   known the row must carry that hash, so a transfer from someone else with
 *   the memo copied into it isn't hidden;
 * - a failed attempt: hidden too (nothing arrived, the purchase is listed).
 * Purchases without a hash (older ones, or settled by finding the memo) keep
 * the memo-only rule.
 */
export function isPurchaseSettlement(
  row: { amount: number; success: boolean; payment_hash?: string },
  p: SettledPurchase,
): boolean {
  if (Number(row.amount) !== p.sats) return false;
  if (!row.success) return true;
  if (!p.settled) return false;
  return !p.paymentHash || row.payment_hash === p.paymentHash;
}

export interface SaleMatchRow {
  direction: string;
  time: string;
  memo?: string;
  amount: number;
  success: boolean;
  payment_hash?: string;
}

export interface SaleMatchOrder {
  id: string;
  sats: string | number;
  amount_lkr: string | number;
  created_at: Date | string;
  bot_payment_hash?: string | null;
}

/**
 * The bot stores a collect's memo wrapped: "💰 Collect by @wallet from @user.
 * Memo: <our memo>". Older transfers have just our memo.
 */
const isSaleMemo = (rowMemo: string | undefined, saleMemo: string) =>
  !!rowMemo && (rowMemo === saleMemo || rowMemo.endsWith(` Memo: ${saleMemo}`));

/**
 * Which rows (by index) are a sale's payment, and whose: row index → order id.
 * First exactly, by the paying transfer's payment_hash (stored on the order
 * when its collect was paid). Then, for orders not matched that way (older
 * sales without a hash), an
 * outgoing successful transfer of the order's exact sats with the memo its
 * collect request carried (saleCollectMemo, the same function that set it,
 * bare or as the bot wraps it), made after the order was created. Each order
 * matches at most one row; by memo, a row goes to the most recent order
 * created before it, so two equal sales each keep their own payment.
 */
export function matchSalePayments(
  rows: SaleMatchRow[],
  orders: SaleMatchOrder[],
): Map<number, string> {
  const matched = new Map<number, string>();
  const paidOut = (row: SaleMatchRow) =>
    row.direction === 'outgoing' && row.success;

  // 1. Exact: the transfer's hash
  const byHash = new Map(
    orders
      .filter((o) => o.bot_payment_hash)
      .map((o) => [o.bot_payment_hash!, o]),
  );
  const hashed = new Set<string>();
  rows.forEach((row, i) => {
    const o = row.payment_hash ? byHash.get(row.payment_hash) : undefined;
    if (!o || !paidOut(row) || hashed.has(o.id)) return;
    hashed.add(o.id);
    matched.set(i, o.id);
  });

  // 2. The rest (older sales without a hash): by sats, memo and time
  const open = orders
    .filter((o) => !hashed.has(o.id))
    .map((o) => ({
      id: o.id,
      sats: Number(o.sats),
      memo: saleCollectMemo(o.amount_lkr),
      createdAt: new Date(o.created_at).getTime(),
    }))
    // newest first: a payment belongs to the latest sale started before it
    .sort((a, b) => b.createdAt - a.createdAt);
  // Oldest payments first, so each claims its own sale before a later one
  const byTime = rows
    .map((row, i) => ({ row, i, at: new Date(row.time).getTime() }))
    .sort((a, b) => a.at - b.at);
  for (const { row, i, at } of byTime) {
    if (matched.has(i) || !paidOut(row)) continue;
    const k = open.findIndex(
      (o) =>
        o.sats === Number(row.amount) &&
        isSaleMemo(row.memo, o.memo) &&
        o.createdAt <= at,
    );
    if (k === -1) continue;
    matched.set(i, open[k].id);
    open.splice(k, 1);
  }
  return matched;
}
