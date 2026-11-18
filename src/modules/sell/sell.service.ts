import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Big from 'big.js';
import type { Knex } from 'knex';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';
import { BitcoinPriceService } from '../bitcoin-price/bitcoin-price.service';
import {
  CeyPayError,
  CeyPayOfframp,
  CeyPayService,
} from '../ceypay/ceypay.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import {
  BankAccountService,
  maskAccountNumber,
} from '../bank-account/bank-account.service';
import { SATS_PER_BTC, SellStatus } from './sell.constants';

/** Payout attempts (CeyPay unreachable) before an order needs a human */
export const MAX_PAYOUT_ATTEMPTS = 5;
const CEYPAY_RATE_CACHE_TTL_SECONDS = 30;

export interface SellOrderRow {
  id: string;
  user_id: string;
  user_bank_account_id: string;
  status: SellStatus;
  sats: string;
  fee_basis_points: number;
  fee_sats: string;
  net_sats: string;
  btc_lkr_buying_rate: string;
  btc_usd_price: string | null;
  amount_lkr: string;
  expires_at: Date;
  fx_lock_id: string | null;
  ceypay_amount_usdt: string | null;
  ceypay_rate_usdt_lkr: string | null;
  ceypay_payment_id: string | null;
  bank_ref: string | null;
  failure_reason: string | null;
  refunded: boolean;
  retry_count: number;
  last_retry_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SellOrderView {
  id: string;
  status: SellStatus;
  sats: number;
  feeBasisPoints: number;
  feeSats: number;
  netSats: number;
  btcLkrRate: number;
  amountLkr: number;
  expiresAt: string;
  bankRef: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * failure_reason holds internal detail (provider errors, float levels) for
 * admins. Users only see a plain reason.
 */
function userFacingReason(row: SellOrderRow): string | null {
  if (!row.failure_reason) return null;
  switch (row.status) {
    case SellStatus.REFUNDED:
      return "The bank transfer couldn't be completed.";
    case SellStatus.EXPIRED:
      // e.g. the wallet rejected the debit (balance spent meanwhile)
      return /insufficient/i.test(row.failure_reason)
        ? 'Not enough sats in your wallet.'
        : 'Nothing was sold.';
    case SellStatus.NEEDS_REVIEW:
      return 'Our team is checking this sale.';
    default:
      return null;
  }
}

export const toSellOrderView = (row: SellOrderRow): SellOrderView => ({
  id: row.id,
  status: row.status,
  sats: Number(row.sats),
  feeBasisPoints: row.fee_basis_points,
  feeSats: Number(row.fee_sats),
  netSats: Number(row.net_sats),
  btcLkrRate: Number(row.btc_lkr_buying_rate),
  amountLkr: Number(row.amount_lkr),
  expiresAt: new Date(row.expires_at).toISOString(),
  bankRef: row.bank_ref,
  failureReason: userFacingReason(row),
  createdAt: new Date(row.created_at).toISOString(),
  completedAt: row.completed_at
    ? new Date(row.completed_at).toISOString()
    : null,
});

/**
 * CEYPAY_WEBHOOK_URL, else BASE_URL + the webhook route. CeyPay refuses
 * non-public URLs (e.g. http://localhost), which would fail every payout, so a
 * local BASE_URL sends none and the status cron settles the sale instead.
 */
export function ceyPayWebhookUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.CEYPAY_WEBHOOK_URL) return env.CEYPAY_WEBHOOK_URL;
  const base = env.BASE_URL?.replace(/\/+$/, '');
  if (!base) return undefined;
  try {
    const { protocol, hostname } = new URL(base);
    if (protocol !== 'https:' || !hostname.includes('.')) return undefined;
  } catch {
    return undefined;
  }
  return `${base}/sell/ceypay-webhook`;
}

/** Fee is taken in sats (rounded up), the rest is priced in LKR (rounded down). */
export function priceSale(
  sats: number,
  feeBasisPoints: number,
  btcLkrBuyingRate: number,
): { feeSats: number; netSats: number; amountLkr: string } {
  const feeSats = new Big(sats)
    .times(feeBasisPoints)
    .div(10000)
    .round(0, Big.roundUp);
  const netSats = new Big(sats).minus(feeSats);
  const amountLkr = netSats
    .div(SATS_PER_BTC)
    .times(btcLkrBuyingRate)
    .round(2, Big.roundDown);
  return {
    feeSats: feeSats.toNumber(),
    netSats: netSats.toNumber(),
    amountLkr: amountLkr.toFixed(2),
  };
}

/** USDT to quote so CeyPay pays at least `amountLkr` (8dp, rounded up). */
export const usdtFor = (amountLkr: string, rateUsdtLkr: number): string =>
  new Big(amountLkr).div(rateUsdtLkr).round(8, Big.roundUp).toFixed(8);

/**
 * Sell flow: user sells sats for LKR to their verified bank account.
 *
 *   quote (our own FX) -> confirm: collect sats from the user's wallet ->
 *   CeyPay off-ramp (paid from our LKR float) -> webhook COMPLETED, or
 *   FAILED -> sats refunded.
 *
 * Every status change is a conditional update on the current status, so a
 * late webhook or poll can never move an order backwards.
 */
@Injectable()
export class SellService {
  private readonly logger = new Logger(SellService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly redisService: RedisService,
    private readonly bitcoinDeepa: BitcoinDeepaService,
    private readonly bitcoinPrice: BitcoinPriceService,
    private readonly ceyPay: CeyPayService,
    private readonly bankAccounts: BankAccountService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  private get knex(): Knex {
    return this.knexService.knex;
  }

  private static feeBasisPoints(): number {
    return parseInt(process.env.BITCOINDEEPA_SELL_FEE_BASIS_POINTS || '0', 10);
  }

  private static quoteTtlSeconds(): number {
    return parseInt(process.env.SELL_QUOTE_TTL_SECONDS || '60', 10);
  }

  private static minSats(): number {
    return parseInt(process.env.SELL_MIN_SATS || '1000', 10);
  }

  /** Live estimate for the UI; not a quote. */
  async getPrice(): Promise<{
    btcLkrRate: number;
    feeBasisPoints: number;
    /** Smallest sale the API accepts, so the app's form uses the same rule */
    minSats: number;
  }> {
    const rate = await this.bitcoinPrice.getBtcLkrSellRate();
    if (!rate) {
      throw new ServiceUnavailableException('Price is unavailable right now');
    }
    return {
      btcLkrRate: rate.buyingRateLkr,
      feeBasisPoints: SellService.feeBasisPoints(),
      minSats: SellService.minSats(),
    };
  }

  async quote(userId: string, sats: number): Promise<SellOrderView> {
    if (sats < SellService.minSats()) {
      throw new BadRequestException(
        `Minimum sale is ${SellService.minSats()} sats`,
      );
    }
    const account = await this.bankAccounts.getVerifiedAccount(userId);
    if (!account) throw new BadRequestException('No verified bank account');

    const balance = await this.bitcoinDeepa.getUserBalance(Number(userId));
    if (!balance.success || typeof balance.balance !== 'number') {
      throw new ServiceUnavailableException(
        'Could not read your balance, please try again',
      );
    }
    if (balance.balance < sats) {
      throw new BadRequestException('Insufficient balance');
    }

    const rate = await this.bitcoinPrice.getBtcLkrSellRate();
    if (!rate) {
      throw new ServiceUnavailableException('Price is unavailable right now');
    }
    const feeBasisPoints = SellService.feeBasisPoints();
    const priced = priceSale(sats, feeBasisPoints, rate.buyingRateLkr);
    if (priced.netSats <= 0 || Number(priced.amountLkr) <= 0) {
      throw new BadRequestException('Amount is too small to sell');
    }

    const row = await this.knex.transaction(async (trx) => {
      // One live quote per user
      await trx('sell_order')
        .where({ user_id: userId, status: SellStatus.QUOTED })
        .update({ status: SellStatus.EXPIRED, updated_at: trx.fn.now() });

      const [inserted] = await trx<SellOrderRow>('sell_order')
        .insert({
          user_id: userId,
          user_bank_account_id: account.id,
          status: SellStatus.QUOTED,
          sats: String(sats),
          fee_basis_points: feeBasisPoints,
          fee_sats: String(priced.feeSats),
          net_sats: String(priced.netSats),
          btc_lkr_buying_rate: String(rate.buyingRateLkr),
          btc_usd_price: rate.usdPrice === null ? null : String(rate.usdPrice),
          amount_lkr: priced.amountLkr,
          expires_at: new Date(
            Date.now() + SellService.quoteTtlSeconds() * 1000,
          ),
        })
        .returning('*');
      return inserted;
    });
    return toSellOrderView(row);
  }

  async listOrders(userId: string, limit = 50): Promise<SellOrderView[]> {
    const rows = await this.knex<SellOrderRow>('sell_order')
      .where('user_id', userId)
      .whereNot('status', SellStatus.EXPIRED)
      .orderBy('created_at', 'desc')
      .limit(limit);
    return rows.map(toSellOrderView);
  }

  async getOrder(userId: string, id: string): Promise<SellOrderView> {
    const row = await this.knex<SellOrderRow>('sell_order')
      .where({ id, user_id: userId })
      .first();
    if (!row) throw new NotFoundException('Order not found');
    return toSellOrderView(row);
  }

  /**
   * Take the sats (memo `sell:<id>` makes the debit idempotent on the bot
   * side), then create the CeyPay payout. The order row stays locked during
   * the debit so a double-tap can't collect twice.
   */
  async confirm(userId: string, id: string): Promise<SellOrderView> {
    type Outcome =
      | { kind: 'collected'; order: SellOrderRow }
      | { kind: 'unknown'; order: SellOrderRow }
      | { kind: 'rejected'; order: SellOrderRow; message: string }
      | { kind: 'expired' }
      | { kind: 'done'; order: SellOrderRow };

    const outcome = await this.knex.transaction(
      async (trx): Promise<Outcome> => {
        const order = await trx<SellOrderRow>('sell_order')
          .where({ id, user_id: userId })
          .forUpdate()
          .first();
        if (!order) throw new NotFoundException('Order not found');
        // Already confirmed (double-tap / retry): report where it is
        if (order.status !== SellStatus.QUOTED) {
          if (order.status === SellStatus.EXPIRED) return { kind: 'expired' };
          return { kind: 'done', order };
        }
        if (new Date(order.expires_at).getTime() <= Date.now()) {
          await this.setStatus(trx, id, [SellStatus.QUOTED], {
            status: SellStatus.EXPIRED,
          });
          return { kind: 'expired' };
        }

        const account = await this.bankAccounts.getVerifiedAccount(userId, trx);
        if (!account || account.id !== order.user_bank_account_id) {
          throw new ConflictException(
            'Your bank account changed. Please get a new quote.',
          );
        }

        const result = await this.bitcoinDeepa.collectFunds(
          Number(order.sats),
          userId,
          `sell:${order.id}`,
        );
        if (result.success || result.already_completed) {
          const updated = await this.setStatus(trx, id, [SellStatus.QUOTED], {
            status: SellStatus.SATS_COLLECTED,
          });
          return { kind: 'collected', order: updated! };
        }
        if (result.outcome_unknown) {
          const updated = await this.setStatus(trx, id, [SellStatus.QUOTED], {
            status: SellStatus.NEEDS_REVIEW,
            failure_reason: `Collect outcome unknown: ${result.message ?? ''}`,
          });
          return { kind: 'unknown', order: updated! };
        }
        const message = result.message || 'Could not take the sats';
        await this.setStatus(trx, id, [SellStatus.QUOTED], {
          status: SellStatus.EXPIRED,
          failure_reason: message,
        });
        return { kind: 'rejected', order, message };
      },
    );

    switch (outcome.kind) {
      case 'expired':
        throw new GoneException('Quote expired, please get a new one');
      case 'rejected':
        throw new BadRequestException(outcome.message);
      case 'done':
        return toSellOrderView(outcome.order);
      case 'unknown':
        await this.telegramLogger.logAlert(
          'Sell',
          `Sell order ${outcome.order.id}: collecting ${outcome.order.sats} sats from #UID${userId} timed out. ` +
            `Check the bot ledger for memo sell:${outcome.order.id} before doing anything.`,
        );
        return toSellOrderView(outcome.order);
      case 'collected':
        await this.createPayout(outcome.order.id);
        return this.getOrder(userId, id);
    }
  }

  /**
   * Create the CeyPay off-ramp for a SATS_COLLECTED order. Safe to call again
   * (from the retry cron): CeyPay dedupes on externalRef = order id.
   */
  async createPayout(id: string): Promise<void> {
    const claimed = await this.claimForPayout(id);
    if (!claimed) return;
    const order = claimed;

    const account = await this.knex('user_bank_account as b')
      .join('user as u', 'u.id', 'b.user_id')
      .where('b.id', order.user_bank_account_id)
      .first<{
        status: string;
        is_active: boolean;
        ceypay_user_bank_id: string | null;
        ceypay_user_id: string | null;
        bank_name: string;
        account_number: string;
      }>('b.status', 'b.is_active', 'b.ceypay_user_bank_id', 'u.ceypay_user_id', 'b.bank_name', 'b.account_number');
    // Checked again at payout time, like CeyFi: the account may have been
    // removed or (in future) un-verified since the quote.
    if (
      !account ||
      account.status !== 'VERIFIED' ||
      !account.is_active ||
      !account.ceypay_user_bank_id ||
      !account.ceypay_user_id
    ) {
      await this.refund(order, 'Bank account is no longer verified');
      return;
    }

    let offramp: CeyPayOfframp;
    try {
      const quote = await this.lockCeyPayQuote(order.amount_lkr);
      await this.knex('sell_order')
        .where('id', id)
        .update({
          fx_lock_id: quote.fxLockId,
          ceypay_amount_usdt: String(quote.amountUsdt),
          ceypay_rate_usdt_lkr: String(quote.rateUsdtLkr),
          updated_at: this.knex.fn.now(),
        });
      offramp = await this.ceyPay.createOfframp({
        fxLockId: quote.fxLockId,
        userId: account.ceypay_user_id,
        userBankId: account.ceypay_user_bank_id,
        externalRef: order.id,
        webhookUrl: ceyPayWebhookUrl(),
      });
    } catch (error) {
      const err =
        error instanceof CeyPayError
          ? error
          : CeyPayService.toError(error, 'payout');
      if (err.outcomeUnknown) {
        // Retried by the cron with the same externalRef
        this.logger.warn(
          `Sell ${id}: payout attempt ${order.retry_count} failed, will retry: ${err.message}`,
        );
        if (order.retry_count >= MAX_PAYOUT_ATTEMPTS) {
          await this.setStatus(this.knex, id, [SellStatus.SATS_COLLECTED], {
            status: SellStatus.NEEDS_REVIEW,
            failure_reason: err.message,
          });
          await this.telegramLogger.logAlert(
            'Sell',
            `Sell order ${id}: CeyPay payout failed ${order.retry_count} times (${err.message}). ` +
              `Sats are collected; check CeyPay for externalRef ${id} before paying out or refunding.`,
          );
        }
        return;
      }
      if (err.status === 422) {
        await this.telegramLogger.logAlert(
          'Sell',
          `CeyPay rejected a ${order.amount_lkr} LKR payout (sell ${id}): ${err.message}. Top up the CeyPay float.`,
        );
      }
      await this.refund(order, err.message);
      return;
    }

    const updated = await this.setStatus(
      this.knex,
      id,
      [SellStatus.SATS_COLLECTED],
      {
        status: SellStatus.PAYOUT_PENDING,
        ceypay_payment_id: offramp.paymentId,
      },
    );
    if (!updated) {
      // The webhook got here first; store the payment id if it's missing
      await this.knex('sell_order')
        .where('id', id)
        .whereNull('ceypay_payment_id')
        .update({ ceypay_payment_id: offramp.paymentId });
    }
    // Sandbox auto-complete (or a replayed externalRef) can already be final
    if (offramp.status === 'COMPLETED' || offramp.status === 'FAILED') {
      await this.applyOfframp(id, offramp);
    }
  }

  /**
   * Apply a final CeyPay status (webhook or poll). Returns false when the
   * order wasn't found or the update didn't apply.
   */
  async applyOfframp(
    orderId: string,
    offramp: Pick<
      CeyPayOfframp,
      'paymentId' | 'status' | 'bankRef' | 'failureReason'
    >,
  ): Promise<boolean> {
    const order = await this.knex<SellOrderRow>('sell_order')
      .where('id', orderId)
      .first();
    if (!order) return false;
    if (
      order.ceypay_payment_id &&
      order.ceypay_payment_id !== offramp.paymentId
    ) {
      this.logger.warn(
        `Sell ${orderId}: CeyPay payment ${offramp.paymentId} doesn't match ${order.ceypay_payment_id}`,
      );
      return false;
    }
    const open = [SellStatus.SATS_COLLECTED, SellStatus.PAYOUT_PENDING];

    if (offramp.status === 'COMPLETED') {
      const updated = await this.setStatus(this.knex, orderId, open, {
        status: SellStatus.COMPLETED,
        ceypay_payment_id: offramp.paymentId,
        bank_ref: offramp.bankRef ?? null,
        completed_at: this.knex.fn.now(),
        failure_reason: null,
      });
      if (!updated) return false;
      await this.notifyCompleted(updated);
      return true;
    }

    if (offramp.status === 'FAILED') {
      if (!open.includes(order.status)) return false;
      await this.knex('sell_order')
        .where('id', orderId)
        .whereNull('ceypay_payment_id')
        .update({ ceypay_payment_id: offramp.paymentId });
      return this.refund(
        { ...order, ceypay_payment_id: offramp.paymentId },
        offramp.failureReason || 'Bank transfer failed',
      );
    }
    return false;
  }

  /**
   * Give the user's sats back (the full amount: no sale happened). An
   * unknown or failed refund leaves the order for a human.
   */
  private async refund(order: SellOrderRow, reason: string): Promise<boolean> {
    const open = [SellStatus.SATS_COLLECTED, SellStatus.PAYOUT_PENDING];
    // Claim it first so the webhook and the poll can't both refund
    const claimed = await this.setStatus(this.knex, order.id, open, {
      status: SellStatus.NEEDS_REVIEW,
      failure_reason: `Refunding: ${reason}`,
    });
    if (!claimed) return false;

    const result = await this.bitcoinDeepa.transferFunds(
      Number(order.sats),
      order.user_id,
      `sell-refund:${order.id}`,
    );
    if (result.success || result.already_completed) {
      await this.setStatus(this.knex, order.id, [SellStatus.NEEDS_REVIEW], {
        status: SellStatus.REFUNDED,
        refunded: true,
        failure_reason: reason,
      });
      await this.telegramLogger.notifyUser(
        order.user_id,
        `↩️ <b>Sale cancelled</b>\nWe couldn't pay out ${order.amount_lkr} LKR, so ${Number(order.sats).toLocaleString('en-US')} sats were returned to your wallet.`,
      );
      return true;
    }

    await this.knex('sell_order')
      .where('id', order.id)
      .update({
        failure_reason: `Refund ${result.outcome_unknown ? 'outcome unknown' : 'failed'} (${result.message ?? ''}) after: ${reason}`,
        updated_at: this.knex.fn.now(),
      });
    await this.telegramLogger.logAlert(
      'Sell',
      `Sell order ${order.id}: payout failed (${reason}) and refunding ${order.sats} sats to #UID${order.user_id} ` +
        `${result.outcome_unknown ? 'timed out' : `failed: ${result.message}`}. ` +
        `Check the bot ledger for memo sell-refund:${order.id}.`,
    );
    return true;
  }

  private async notifyCompleted(order: SellOrderRow) {
    const account = await this.knex('user_bank_account')
      .where('id', order.user_bank_account_id)
      .first<{ bank_name: string; account_number: string }>();
    await this.telegramLogger.notifyUser(
      order.user_id,
      `💸 <b>Sale complete</b>\n${order.amount_lkr} LKR was sent to ` +
        `${account ? `${account.bank_name} ${maskAccountNumber(account.account_number)}` : 'your bank account'}.`,
    );
  }

  /**
   * Lock a CeyPay quote whose LKR amount covers ours. CeyPay quotes in USDT,
   * so we size the USDT amount from its current rate (cached briefly).
   */
  private async lockCeyPayQuote(amountLkr: string) {
    let rate = await this.redisService.getOrSet(
      CacheKeys.sell.ceypayRate(),
      CEYPAY_RATE_CACHE_TTL_SECONDS,
      async () => (await this.ceyPay.getQuote('1')).rateUsdtLkr,
    );
    if (!rate || !(rate > 0)) {
      throw new CeyPayError('CeyPay returned no rate', undefined, true);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const quote = await this.ceyPay.getQuote(usdtFor(amountLkr, rate));
      if (new Big(quote.amountLkr).gte(amountLkr)) return quote;
      // Rate moved since it was cached: size again from this quote's rate
      rate = quote.rateUsdtLkr;
      await this.redisService.set(CacheKeys.sell.ceypayRate(), rate, {
        ttl: CEYPAY_RATE_CACHE_TTL_SECONDS,
      });
    }
    throw new CeyPayError(
      'CeyPay quote does not cover the LKR amount',
      undefined,
      true,
    );
  }

  /** Atomically count a payout attempt (FOR UPDATE SKIP LOCKED). */
  private async claimForPayout(id: string): Promise<SellOrderRow | null> {
    return this.knex.transaction(async (trx) => {
      const order = await trx<SellOrderRow>('sell_order')
        .where({ id, status: SellStatus.SATS_COLLECTED })
        .whereNull('ceypay_payment_id')
        .forUpdate()
        .skipLocked()
        .first();
      if (!order) return null;
      const [updated] = await trx<SellOrderRow>('sell_order')
        .where('id', id)
        .update({
          retry_count: order.retry_count + 1,
          last_retry_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return updated;
    });
  }

  /** Forward-only status change; undefined when the order wasn't in `from`. */
  private async setStatus(
    db: Knex | Knex.Transaction,
    id: string,
    from: SellStatus[],
    changes: Record<string, unknown>,
  ): Promise<SellOrderRow | undefined> {
    const [row] = await db<SellOrderRow>('sell_order')
      .where('id', id)
      .whereIn('status', from)
      .update({ ...changes, updated_at: db.fn.now() })
      .returning('*');
    return row;
  }
}
