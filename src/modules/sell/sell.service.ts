import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  LKR_DP,
  ROUND_DOWN,
  ROUND_HALF_UP,
  ROUND_UP,
  USDT_DP,
  basisPointsOf,
  lkr,
  sameAmount,
  sats as wholeSats,
  toApiNumber,
  toMoney,
  usdt,
} from '../../common/money';
import type { Knex } from 'knex';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import {
  BitcoinDeepaService,
  type CollectRequest,
  type CollectResult,
} from '../bitcoindeepa/bitcoindeepa.service';
import { P2pService } from '../p2p/p2p.service';
import { isP2pEnabled } from '../../common/p2p-enabled';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import {
  BitcoinPriceService,
  type BtcLkrRate,
} from '../bitcoin-price/bitcoin-price.service';
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
import {
  CollectState,
  COUNTED_SELL_STATUSES,
  DEFAULT_SELL_DAILY_MAX_SATS,
  DEFAULT_SELL_MAX_SATS,
  SATS_PER_BTC,
  saleCollectMemo,
  SellStatus,
} from './sell.constants';

/** Payout attempts (CeyPay unreachable) before an order needs a human */
export const MAX_PAYOUT_ATTEMPTS = 5;

/**
 * A SATS_COLLECTED order that has used every payout attempt and hasn't been
 * touched for this long was left behind (the process died during the last
 * attempt, or parking it failed): recoverStuckOrders hands it to a human.
 */
const STUCK_PAYOUT_MINUTES = 5;

/**
 * A COLLECTING order still open this long after its approval window was left
 * behind: the bot's request lives 15 min, and an approved payment above the
 * user's daily allowance waits up to 10 min more for Confirm in the bot chat.
 */
const STUCK_COLLECT_MINUTES = 30;

/** Bot transfer statuses that end a payment without moving sats */
const FAILED_TRANSFER_STATUSES = ['failed', 'cancelled', 'expired'];

/** The bot refused because of our setup, not the user: alert */
const COLLECT_CONFIG_CODES = [
  'auth',
  'collect_not_allowed',
  'collector_not_allowed',
];

const DECLINED_REASON = 'Declined by the user';

/** An order read syncs with the bot at most once per this many seconds */
const READ_SYNC_SECONDS = 3;

/**
 * "The next payout attempt is due": attempts left, and 2^n minutes have
 * passed since attempt n. Used (as `.where(payoutAttemptDue)`) by the retry
 * cron to pick orders and again by the claim itself, so a claim made from a
 * stale read can't start a second payout next to one that is still running.
 */
export function payoutAttemptDue(qb: Knex.QueryBuilder): void {
  void qb.where('retry_count', '<', MAX_PAYOUT_ATTEMPTS).where((due) => {
    void due
      .whereNull('last_retry_at')
      .orWhereRaw(
        "last_retry_at + (power(2, retry_count) * interval '1 minute') <= now()",
      );
  });
}

export interface SellOrderRow {
  id: string;
  user_id: string;
  user_bank_account_id: string;
  status: SellStatus;
  sats: string;
  fee_basis_points: number;
  gross_lkr: string;
  fee_lkr: string;
  bank_charge_lkr: string;
  btc_lkr_buying_rate: string;
  btc_usd_price: string | null;
  amount_lkr: string;
  expires_at: Date;
  fx_lock_id: string | null;
  ceypay_amount_usdt: string | null;
  ceypay_rate_usdt_lkr: string | null;
  ceypay_payment_id: string | null;
  bot_collect_id: string | null;
  bot_payment_hash: string | null;
  collect_expires_at: Date | null;
  collect_state: CollectState | null;
  bank_ref: string | null;
  failure_reason: string | null;
  refunded: boolean;
  retry_count: number;
  last_retry_at: Date | null;
  alerted_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SellOrderView {
  id: string;
  status: SellStatus;
  sats: number;
  feeBasisPoints: number;
  /** The whole sale at the rate, before the fee */
  grossLkr: number;
  feeLkr: number;
  /** Flat bank transfer charge, taken after the fee */
  bankChargeLkr: number;
  btcLkrRate: number;
  amountLkr: number;
  expiresAt: string;
  bankRef: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  /**
   * While COLLECTING: the user must approve the payment (in the bot chat, or
   * in the app when payInApp) before expiresAt. state: requesting (asking the
   * bot), pending (waiting for the user), awaiting_confirmation (approved;
   * Confirm in the bot chat), processing / in_flight (being paid).
   */
  collect: {
    state: CollectState;
    expiresAt: string;
    payInApp: boolean;
  } | null;
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
      if (row.failure_reason === DECLINED_REASON) {
        return 'You declined the payment. Nothing was sold.';
      }
      return /insufficient|not enough|balance/i.test(row.failure_reason)
        ? 'Not enough sats in your wallet.'
        : 'Nothing was sold.';
    case SellStatus.REFUNDING:
      return "The bank transfer couldn't be completed. Returning your sats.";
    case SellStatus.NEEDS_REVIEW:
      return 'Our team is checking this sale.';
    default:
      return null;
  }
}

// API serialization point: whole sats and 2-dp LKR are exact as numbers
export const toSellOrderView = (row: SellOrderRow): SellOrderView => ({
  id: row.id,
  status: row.status,
  sats: toApiNumber(row.sats),
  feeBasisPoints: row.fee_basis_points,
  grossLkr: toApiNumber(row.gross_lkr),
  feeLkr: toApiNumber(row.fee_lkr),
  bankChargeLkr: toApiNumber(row.bank_charge_lkr),
  btcLkrRate: toApiNumber(row.btc_lkr_buying_rate),
  amountLkr: toApiNumber(row.amount_lkr),
  expiresAt: new Date(row.expires_at).toISOString(),
  bankRef: row.bank_ref,
  failureReason: userFacingReason(row),
  createdAt: new Date(row.created_at).toISOString(),
  completedAt: row.completed_at
    ? new Date(row.completed_at).toISOString()
    : null,
  collect:
    row.status === SellStatus.COLLECTING && row.collect_expires_at
      ? {
          state: row.collect_state ?? CollectState.REQUESTING,
          expiresAt: new Date(row.collect_expires_at).toISOString(),
          payInApp:
            isP2pEnabled() &&
            !!row.bot_collect_id &&
            row.collect_state === CollectState.PENDING,
        }
      : null,
});

const STORED_COLLECT_STATES = new Set<string>(
  Object.values(CollectState).filter((s) => s !== CollectState.REQUESTING),
);

/**
 * The bot's request (or, once approved, its transfer) status as ours. One we
 * don't know yet is PROCESSING: still going, checked again on the next sync.
 */
export function toCollectState(request: CollectRequest): CollectState {
  const raw =
    request.status === 'approved'
      ? (request.transfer?.status ?? CollectState.PROCESSING)
      : request.status;
  return STORED_COLLECT_STATES.has(raw)
    ? (raw as CollectState)
    : CollectState.PROCESSING;
}

/** Shown to the user in the bot's Pay / Decline prompt */
const collectMemo = (row: SellOrderRow): string =>
  saleCollectMemo(row.amount_lkr);

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

/**
 * Prices the whole sale in LKR (rounded down), takes the fee off it in LKR
 * (rounded up), then the flat bank charge. `amountLkr` is what the user gets.
 */
export function priceSale(
  sats: number | string,
  feeBasisPoints: number,
  btcLkrRate: number | string,
  bankChargeLkr: number | string = 0,
): {
  grossLkr: string;
  feeLkr: string;
  bankChargeLkr: string;
  amountLkr: string;
} {
  const grossLkr = lkr(
    toMoney(sats).div(SATS_PER_BTC).times(toMoney(btcLkrRate)),
    ROUND_DOWN,
  );
  const feeLkr = lkr(basisPointsOf(grossLkr, feeBasisPoints), ROUND_UP);
  const chargeLkr = lkr(bankChargeLkr, ROUND_HALF_UP);
  return {
    grossLkr: grossLkr.toFixed(LKR_DP),
    feeLkr: feeLkr.toFixed(LKR_DP),
    bankChargeLkr: chargeLkr.toFixed(LKR_DP),
    amountLkr: grossLkr.minus(feeLkr).minus(chargeLkr).toFixed(LKR_DP),
  };
}

/** USDT to quote so CeyPay pays at least `amountLkr` (8dp, rounded up). */
export const usdtFor = (
  amountLkr: string,
  rateUsdtLkr: number | string,
): string =>
  usdt(toMoney(amountLkr).div(toMoney(rateUsdtLkr)), ROUND_UP).toFixed(USDT_DP);

/**
 * Sell flow: user sells sats for LKR to their verified bank account.
 *
 *   quote (our own FX) -> confirm: ask the user to pay us (bot collect
 *   request) -> they approve, the sats arrive -> CeyPay off-ramp (paid from
 *   our LKR float) -> webhook COMPLETED, or FAILED -> sats refunded.
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
    private readonly p2p: P2pService,
  ) {}

  private get knex(): Knex {
    return this.knexService.knex;
  }

  private static feeBasisPoints(): number {
    return parseInt(process.env.BITCOINDEEPA_SELL_FEE_BASIS_POINTS || '0', 10);
  }

  /** Flat LKR bank transfer charge per sale (default 30; 0 must be explicit) */
  private static bankChargeLkr(): number {
    const raw = process.env.SELL_BANK_CHARGE_LKR;
    return raw === undefined || raw.trim() === '' ? 30 : Number(raw);
  }

  private static quoteTtlSeconds(): number {
    return parseInt(process.env.SELL_QUOTE_TTL_SECONDS || '60', 10);
  }

  private static collectWindowSeconds(): number {
    return parseInt(process.env.SELL_COLLECT_WINDOW_SECONDS || '300', 10);
  }

  private static minSats(): number {
    return parseInt(process.env.SELL_MIN_SATS || '1000', 10);
  }

  private static maxSats(): number {
    return parseInt(
      process.env.SELL_MAX_SATS || String(DEFAULT_SELL_MAX_SATS),
      10,
    );
  }

  private static dailyMaxSats(): number {
    return parseInt(
      process.env.SELL_DAILY_MAX_SATS || String(DEFAULT_SELL_DAILY_MAX_SATS),
      10,
    );
  }

  /** Refuse a sale that would take the member past the rolling 24h limit. */
  private async assertWithinDailyLimit(
    db: Knex | Knex.Transaction,
    userId: string,
    sats: number,
  ): Promise<void> {
    const row = await db('sell_order')
      .where('user_id', userId)
      .whereIn('status', COUNTED_SELL_STATUSES)
      .where('created_at', '>', db.raw("now() - interval '24 hours'"))
      .sum<{ total: string | null }>('sats as total')
      .first();
    const used = toMoney(row?.total); // SUM(bigint) comes back as a string
    const max = SellService.dailyMaxSats();
    if (used.plus(sats).gt(max)) {
      const remaining = wholeSats(toMoney(max).minus(used), ROUND_DOWN);
      const left = remaining.lt(0) ? 0 : toApiNumber(remaining);
      throw new BadRequestException(
        left > 0
          ? `You can sell up to ${left.toLocaleString('en-US')} more sats today`
          : `You've reached today's limit of ${max.toLocaleString('en-US')} sats`,
      );
    }
  }

  /** Live estimate for the UI; not a quote. */
  async getPrice(): Promise<{
    btcLkrRate: number;
    feeBasisPoints: number;
    /** Flat LKR charge per sale, taken after the fee */
    bankChargeLkr: number;
    /** Smallest and largest single sale, so the app's form uses the same rules */
    minSats: number;
    maxSats: number;
  }> {
    const rate = await this.sellRate();
    return {
      btcLkrRate: rate.btcLkr,
      feeBasisPoints: SellService.feeBasisPoints(),
      bankChargeLkr: SellService.bankChargeLkr(),
      minSats: SellService.minSats(),
      maxSats: SellService.maxSats(),
    };
  }

  async quote(userId: string, sats: number): Promise<SellOrderView> {
    if (sats < SellService.minSats()) {
      throw new BadRequestException(
        `Minimum sale is ${SellService.minSats()} sats`,
      );
    }
    if (sats > SellService.maxSats()) {
      throw new BadRequestException(
        `Maximum sale is ${SellService.maxSats().toLocaleString('en-US')} sats`,
      );
    }
    // Early answer; confirm checks again under a lock
    await this.assertWithinDailyLimit(this.knex, userId, sats);
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

    const rate = await this.sellRate();
    const feeBasisPoints = SellService.feeBasisPoints();
    const priced = priceSale(
      sats,
      feeBasisPoints,
      rate.btcLkr,
      SellService.bankChargeLkr(),
    );
    if (toMoney(priced.amountLkr).lte(0)) {
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
          gross_lkr: priced.grossLkr,
          fee_lkr: priced.feeLkr,
          bank_charge_lkr: priced.bankChargeLkr,
          btc_lkr_buying_rate: String(rate.btcLkr),
          btc_usd_price: String(rate.btcUsd),
          ceypay_rate_usdt_lkr: String(rate.usdtLkr),
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

  /** The order, brought up to date with the bot while it waits for the user */
  async getOrder(userId: string, id: string): Promise<SellOrderView> {
    const row = await this.findOrder(userId, id);
    if (row.status !== SellStatus.COLLECTING) return toSellOrderView(row);
    // The app polls every 3s and the cron syncs too: one bot call per window
    const due = await this.redisService.setIfAbsent(
      CacheKeys.sell.collectSync(id),
      READ_SYNC_SECONDS,
    );
    if (!due) return toSellOrderView(row);
    try {
      await this.syncCollect(row);
    } catch (error) {
      this.logger.warn(`Sell ${id}: collect sync failed: ${String(error)}`);
    }
    return toSellOrderView(await this.findOrder(userId, id));
  }

  private async findOrder(userId: string, id: string): Promise<SellOrderRow> {
    const row = await this.knex<SellOrderRow>('sell_order')
      .where({ id, user_id: userId })
      .first();
    if (!row) throw new NotFoundException('Order not found');
    return row;
  }

  /**
   * Ask the user to pay the sats (a bot collect request); the payout follows
   * once they arrive (applyCollect).
   *
   * The order moves QUOTED -> COLLECTING in its own committed transaction
   * before the bot is called, with the approval deadline. external_id = the
   * order id makes the request idempotent, so a lost answer is fixed by
   * asking again (syncCollect). Nothing moves until the user approves, in the
   * bot chat or in the app (payInApp).
   */
  async confirm(userId: string, id: string): Promise<SellOrderView> {
    type Claim =
      | { kind: 'claimed'; order: SellOrderRow }
      | { kind: 'expired' }
      | { kind: 'done'; order: SellOrderRow };

    const claim = await this.knex.transaction(async (trx): Promise<Claim> => {
      // One confirm per member at a time, so the daily limit can't be raced.
      // NO KEY UPDATE, like the buy flow: a plain FOR UPDATE blocks the FK
      // share lock a new quote's insert takes on this row, and that quote
      // already holds the order row we lock next (it expires the old quote
      // first), so the two would deadlock.
      await trx('user').where('id', userId).forNoKeyUpdate().first();
      const order = await trx<SellOrderRow>('sell_order')
        .where({ id, user_id: userId })
        .forUpdate()
        .first();
      if (!order) throw new NotFoundException('Order not found');
      // Already confirmed (double-tap / retry): report where it is
      if (order.status !== SellStatus.QUOTED) {
        if (order.status === SellStatus.EXPIRED && !order.collect_expires_at) {
          return { kind: 'expired' };
        }
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
      await this.assertWithinDailyLimit(trx, userId, Number(order.sats));

      const claimed = await this.setStatus(trx, id, [SellStatus.QUOTED], {
        status: SellStatus.COLLECTING,
        collect_expires_at: new Date(
          Date.now() + SellService.collectWindowSeconds() * 1000,
        ),
      });
      return { kind: 'claimed', order: claimed! };
    });

    if (claim.kind === 'expired') {
      throw new GoneException('Quote expired, please get a new one');
    }
    if (claim.kind === 'done') return this.getOrder(userId, id);
    // Now a sale in the member's history (setStatus ran inside the transaction)
    await this.clearHistoryCache(userId);

    // No lock held while the bot works
    const order = claim.order;
    const result = await this.bitcoinDeepa.createCollect(
      userId,
      toApiNumber(order.sats), // whole sats: exact
      collectMemo(order),
      order.id,
    );
    if (result.kind === 'refused') {
      await this.collectRefused(order, result);
      if (COLLECT_CONFIG_CODES.includes(result.code)) {
        throw new ServiceUnavailableException(
          'Selling is not available right now. Please try again later.',
        );
      }
      throw new BadRequestException(
        result.code === 'payer_not_linked'
          ? 'Please log in again, then try again.'
          : result.code === 'recipient_not_found'
            ? 'Open the Bitcoin Deepa bot once, then try again.'
            : result.message || 'Could not start the payment',
      );
    }
    // Unknown: stays COLLECTING and the sync cron asks again (same external_id)
    if (result.kind === 'ok') await this.applyCollect(order, result.request);
    return toSellOrderView(await this.findOrder(userId, id));
  }

  /**
   * Bring a COLLECTING order up to date with its bot request (cron, order
   * reads, the app's Pay). Creates the request if confirm got no answer, and
   * withdraws it once the approval window has passed.
   */
  async syncCollect(order: SellOrderRow): Promise<void> {
    // Orders from before collect requests have no window: recoverStuckOrders
    if (order.status !== SellStatus.COLLECTING || !order.collect_expires_at) {
      return;
    }
    const result: CollectResult = order.bot_collect_id
      ? await this.bitcoinDeepa.getCollect(order.bot_collect_id)
      : await this.bitcoinDeepa.createCollect(
          order.user_id,
          toApiNumber(order.sats), // whole sats: exact
          collectMemo(order),
          order.id,
        );
    if (result.kind === 'ok') return this.applyCollect(order, result.request);
    if (result.kind === 'unknown') return;
    // Our key, clock, allowlist or wallet config: not this order's fault. It
    // stays COLLECTING and moves on once that's fixed (or goes to a human
    // via recoverStuckOrders); one alert, not one per open sale.
    if (COLLECT_CONFIG_CODES.includes(result.code)) {
      return this.alertCollectUnavailable(result);
    }
    // A retried create the bot refused for this request (amount, user, ...)
    if (!order.bot_collect_id) return this.collectRefused(order, result);
    if (result.status !== 404) {
      this.logger.warn(
        `Sell ${order.id}: collect request ${order.bot_collect_id} answered ${result.status} ${result.code}; will ask again`,
      );
      return;
    }
    // We made this request and the bot no longer knows it
    await this.parkCollect(
      order,
      `Collect request ${order.bot_collect_id}: ${result.code} ${result.message}`,
      `the bot answered ${result.status} ${result.code} for collect request ${order.bot_collect_id}`,
    );
  }

  /** Something no rule covers: a human checks the request before anything moves */
  private async parkCollect(
    order: SellOrderRow,
    reason: string,
    alert: string,
  ): Promise<void> {
    const parked = await this.setStatus(
      this.knex,
      order.id,
      [SellStatus.COLLECTING],
      { status: SellStatus.NEEDS_REVIEW, failure_reason: reason },
    );
    if (parked) {
      await this.telegramLogger.logAlert(
        'Sell',
        `Sell order ${order.id} (${order.sats} sats from #UID${order.user_id}): ${alert}. Check the request in the bot before doing anything.`,
      );
    }
  }

  /** Collect calls fail because of our setup: alert at most hourly */
  private async alertCollectUnavailable(
    result: Extract<CollectResult, { kind: 'refused' }>,
  ): Promise<void> {
    this.logger.error(
      `Sell collect unavailable: ${result.status} ${result.code} ${result.message}`,
    );
    if (
      await this.redisService.setIfAbsent(
        CacheKeys.sell.collectUnavailableAlert(),
        60 * 60,
      )
    ) {
      await this.telegramLogger.logAlert(
        'Sell',
        `Sell collect requests are failing (${result.status} ${result.code}: ${result.message}). ` +
          'Check the DCA wallet has can_collect in api.send.whitelisted_wallets, its bot user, our send key, the server clock and the bot IP allowlist. Open sales wait until it is fixed. (Reported at most hourly.)',
      );
    }
  }

  /**
   * The user pays from the app (Mini App or web): the bot's
   * /p2p/collect/{id}/approve as the signed-in user. Bot errors come back as
   * the P2P relay's (relogin_required, ...).
   */
  async payInApp(userId: string, id: string): Promise<SellOrderView> {
    const order = await this.findOrder(userId, id);
    if (order.status !== SellStatus.COLLECTING || !order.bot_collect_id) {
      throw new ConflictException('This sale is not waiting for a payment.');
    }
    if (
      !order.collect_expires_at ||
      new Date(order.collect_expires_at).getTime() <= Date.now()
    ) {
      await this.syncCollect(order);
      throw new GoneException('The time to pay has passed. Nothing was sold.');
    }
    await this.p2p.approveCollect(userId, order.bot_collect_id);
    // Not getOrder: its read throttle could skip the sync the user waits for
    await this.syncCollect(await this.findOrder(userId, id));
    return toSellOrderView(await this.findOrder(userId, id));
  }

  /**
   * The user cancels a sale before paying: a quote expires, a pending
   * request is withdrawn. Once they approved, the payment goes on.
   */
  async cancel(userId: string, id: string): Promise<SellOrderView> {
    const order = await this.findOrder(userId, id);
    if (order.status === SellStatus.QUOTED) {
      await this.setStatus(this.knex, id, [SellStatus.QUOTED], {
        status: SellStatus.EXPIRED,
      });
    } else if (order.status === SellStatus.COLLECTING) {
      // Close the window now; the sync withdraws the request
      const [closed] = await this.knex<SellOrderRow>('sell_order')
        .where({ id, status: SellStatus.COLLECTING })
        .whereNotNull('collect_expires_at')
        .update({ collect_expires_at: this.knex.fn.now() })
        .returning('*');
      if (closed) await this.syncCollect(closed);
    }
    return toSellOrderView(await this.findOrder(userId, id));
  }

  /** Move the order on from what the bot says about its request */
  private async applyCollect(
    order: SellOrderRow,
    request: CollectRequest,
    mayCancel = true,
  ): Promise<void> {
    const state = toCollectState(request);
    // The paying transfer's hash links the sale to its row in the user's bot
    // history (markSalePayments), so the app lists the sale once.
    const paymentHash =
      request.transfer?.payment_hash || order.bot_payment_hash;
    if (
      order.bot_collect_id !== request.id ||
      order.collect_state !== state ||
      order.bot_payment_hash !== paymentHash
    ) {
      await this.knex('sell_order')
        .where({ id: order.id, status: SellStatus.COLLECTING })
        .update({
          bot_collect_id: request.id,
          collect_state: state,
          bot_payment_hash: paymentHash,
        });
    }

    switch (request.status) {
      case 'pending': {
        const windowOver =
          !!order.collect_expires_at &&
          new Date(order.collect_expires_at).getTime() <= Date.now();
        if (!mayCancel || !windowOver) return;
        // Exactly one answer counts: if the user approved first, the cancel
        // is refused (request_closed) and we follow their payment instead
        const cancelled = await this.bitcoinDeepa.cancelCollect(request.id);
        const next =
          cancelled.kind === 'refused' && cancelled.code === 'request_closed'
            ? await this.bitcoinDeepa.getCollect(request.id)
            : cancelled;
        if (next.kind === 'ok') {
          await this.applyCollect(order, next.request, false);
        }
        return;
      }
      case 'approved': {
        if (request.paid) {
          // The one step that pays out from our float: the request must be
          // this order's
          const mismatch =
            !sameAmount(request.amount, order.sats, 0) ||
            (request.external_id !== undefined &&
              request.external_id !== order.id);
          if (mismatch) {
            return this.parkCollect(
              order,
              `Collect request ${request.id} doesn't match the order (amount ${request.amount}, external_id ${request.external_id ?? '-'})`,
              `collect request ${request.id} was paid but doesn't match the order (amount ${request.amount} vs ${order.sats}, external_id ${request.external_id ?? '-'}); no payout was started`,
            );
          }
          return this.markCollected(order);
        }
        const transfer = request.transfer;
        if (transfer && FAILED_TRANSFER_STATUSES.includes(transfer.status)) {
          await this.endCollect(
            order,
            `Payment ${transfer.status}${transfer.error ? `: ${transfer.error}` : ''}`,
          );
        }
        // processing / awaiting_confirmation / in_flight: wait
        return;
      }
      case 'declined':
        return this.endCollect(order, DECLINED_REASON);
      default:
        // cancelled (our window) or expired (the bot's): never answered
        return this.endCollect(
          order,
          `Not approved in time (${request.status})`,
        );
    }
  }

  /** The bot refused to create the request: nothing was asked, nothing moved */
  private async collectRefused(
    order: SellOrderRow,
    result: Extract<CollectResult, { kind: 'refused' }>,
  ): Promise<void> {
    await this.endCollect(
      order,
      `Collect refused: ${result.code} ${result.message}`,
    );
    if (COLLECT_CONFIG_CODES.includes(result.code)) {
      await this.alertCollectUnavailable(result);
    }
  }

  private async endCollect(order: SellOrderRow, reason: string) {
    await this.setStatus(this.knex, order.id, [SellStatus.COLLECTING], {
      status: SellStatus.EXPIRED,
      failure_reason: reason,
    });
  }

  /**
   * The sats are ours: start the payout. Payout attempt 1 is counted in the
   * same update; the retry cron only takes orders whose backoff has passed,
   * so it can't create a second payout while this one is still running.
   */
  private async markCollected(order: SellOrderRow): Promise<void> {
    const collected = await this.setStatus(
      this.knex,
      order.id,
      [SellStatus.COLLECTING],
      {
        status: SellStatus.SATS_COLLECTED,
        collect_state: CollectState.COMPLETED,
        retry_count: 1,
        last_retry_at: this.knex.fn.now(),
      },
    );
    // Not COLLECTING any more: another sync (or the stuck check) got it first
    if (!collected) return;
    await this.redisService.del(
      CacheKeys.transaction.dcaSummary(order.user_id),
    );
    await this.sendPayout(collected);
  }

  /**
   * Retry the CeyPay off-ramp of a SATS_COLLECTED order (retry cron). Does
   * nothing unless the order's next attempt is due.
   */
  async createPayout(id: string): Promise<void> {
    const claimed = await this.claimForPayout(id);
    if (claimed) await this.sendPayout(claimed);
  }

  /**
   * One payout attempt for an order whose attempt is already counted (by
   * confirm or claimForPayout). Safe to repeat: CeyPay dedupes on
   * externalRef = order id.
   */
  private async sendPayout(order: SellOrderRow): Promise<void> {
    const id = order.id;
    // fx_lock_id is stored just before the off-ramp request goes out, so one
    // left by an earlier attempt means that request may have reached CeyPay
    // and we never got a definite answer (an answer would have moved the
    // order on). A payout may exist: see failPayout.
    const payoutMayExist = order.fx_lock_id !== null;

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
      await this.failPayout(
        order,
        'Bank account is no longer verified',
        payoutMayExist,
      );
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
      await this.failPayout(order, err.message, payoutMayExist);
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
      if (!updated) {
        // CeyPay paid the bank, but we already gave (or are giving) the sats
        // back: the member got both. A human must sort this out.
        const refundStates = [
          SellStatus.REFUNDING,
          SellStatus.REFUNDED,
          SellStatus.NEEDS_REVIEW,
        ];
        if (refundStates.includes(order.status)) {
          await this.telegramLogger.logAlert(
            'Sell',
            `Sell order ${orderId}: CeyPay reports the payout COMPLETED (payment ${offramp.paymentId}, bank ref ${offramp.bankRef ?? '-'}) ` +
              `but the order is ${order.status}. The member may have both the LKR and the sats: check before doing anything.`,
          );
        }
        return false;
      }
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
   * The payout can't be created (a definite refusal, not a timeout). Normally
   * that means no sale happened and the sats go back.
   *
   * Not when an earlier attempt's off-ramp request got no answer: CeyPay may
   * have created that payout, and this attempt can fail before CeyPay ever
   * looks at the externalRef (our own bank-account check, the quote call,
   * its auth guards). Refunding then could leave the member with both the
   * LKR and the sats, so a human checks CeyPay first.
   */
  private async failPayout(
    order: SellOrderRow,
    reason: string,
    payoutMayExist: boolean,
  ): Promise<void> {
    if (!payoutMayExist) {
      await this.refund(order, reason);
      return;
    }
    const parked = await this.setStatus(
      this.knex,
      order.id,
      [SellStatus.SATS_COLLECTED],
      {
        status: SellStatus.NEEDS_REVIEW,
        failure_reason: `Payout refused (${reason}) after an earlier attempt with no answer`,
      },
    );
    if (!parked) return;
    await this.telegramLogger.logAlert(
      'Sell',
      `Sell order ${order.id}: the payout was refused (${reason}), but an earlier attempt got no answer from CeyPay and may have created it. ` +
        `${order.sats} sats of #UID${order.user_id} are collected and were NOT refunded: check CeyPay for externalRef ${order.id} before refunding.`,
    );
  }

  /**
   * Give the user's sats back (the full amount: no sale happened). An
   * unknown or failed refund leaves the order for a human.
   */
  private async refund(order: SellOrderRow, reason: string): Promise<boolean> {
    const open = [SellStatus.SATS_COLLECTED, SellStatus.PAYOUT_PENDING];
    // Claim it first so the webhook and the poll can't both refund
    const claimed = await this.setStatus(this.knex, order.id, open, {
      status: SellStatus.REFUNDING,
      failure_reason: reason,
    });
    if (!claimed) return false;

    const result = await this.bitcoinDeepa.transferFunds(
      toApiNumber(order.sats), // whole sats: exact
      order.user_id,
      `sell-refund:${order.id}`,
    );
    if (
      result.success ||
      ('already_completed' in result && result.already_completed)
    ) {
      await this.setStatus(this.knex, order.id, [SellStatus.REFUNDING], {
        status: SellStatus.REFUNDED,
        refunded: true,
        failure_reason: reason,
      });
      await this.telegramLogger.notifyUser(
        order.user_id,
        `↩️ <b>Sale cancelled</b>\nWe couldn't pay out ${order.amount_lkr} LKR, so ${toApiNumber(order.sats).toLocaleString('en-US')} sats were returned to your wallet.`,
      );
      return true;
    }

    const unknown = 'outcome_unknown' in result && result.outcome_unknown;
    // Above the bot's approval threshold: the refund waits for a human in
    // Telegram. Sell has no approval polling, so a person follows it up.
    const approvalId =
      'awaiting_approval_id' in result
        ? result.awaiting_approval_id
        : undefined;
    const outcome = approvalId
      ? `awaiting bot approval (transaction ${approvalId})`
      : unknown
        ? 'outcome unknown'
        : 'failed';
    await this.setStatus(this.knex, order.id, [SellStatus.REFUNDING], {
      status: SellStatus.NEEDS_REVIEW,
      failure_reason: `Refund ${outcome} (${result.message ?? ''}) after: ${reason}`,
    });
    await this.telegramLogger.logAlert(
      'Sell',
      `Sell order ${order.id}: payout failed (${reason}) and refunding ${order.sats} sats to #UID${order.user_id} ` +
        `${approvalId ? `is waiting for approval in the bot (transaction ${approvalId}) - approve it, then mark the order refunded` : unknown ? 'timed out' : `failed: ${result.message}`}. ` +
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

  /** The rate we buy at (see BitcoinPriceService). 503 when unavailable. */
  private async sellRate(): Promise<BtcLkrRate> {
    const rate = await this.bitcoinPrice.getBtcLkrRate();
    if (!rate) {
      throw new ServiceUnavailableException('Price is unavailable right now');
    }
    return rate;
  }

  /**
   * Lock a CeyPay quote whose LKR amount covers ours. CeyPay quotes in USDT,
   * so we size the USDT amount from its current rate (cached briefly).
   */
  private async lockCeyPayQuote(amountLkr: string) {
    let rate = await this.bitcoinPrice.getUsdtLkr();
    for (let attempt = 0; attempt < 2; attempt++) {
      const quote = await this.ceyPay.getQuote(usdtFor(amountLkr, rate));
      if (toMoney(quote.amountLkr).gte(toMoney(amountLkr))) return quote;
      // Rate moved since it was cached: size again from this quote's rate
      rate = quote.rateUsdtLkr;
      await this.bitcoinPrice.setUsdtLkr(rate);
    }
    throw new CeyPayError(
      'CeyPay quote does not cover the LKR amount',
      undefined,
      true,
    );
  }

  /**
   * Orders stuck mid-transfer (the process died between committing the
   * status and recording the bot's answer) go to a human, with the memo to
   * check. Nothing is retried automatically: the debit or refund may or may
   * not have happened.
   *
   * The same for a SATS_COLLECTED order with no payout attempts left: the
   * retry cron no longer takes it, so if the last attempt died (or parking it
   * failed) nothing else would ever look at it.
   */
  async recoverStuckOrders(): Promise<number> {
    const stuck: [
      SellStatus,
      (q: Knex.QueryBuilder) => void,
      (row: SellOrderRow) => string,
    ][] = [
      [
        SellStatus.COLLECTING,
        (q) =>
          void q.where((w) => {
            // Before collect requests: the debit call itself
            void w
              .where((old) => {
                void old
                  .whereNull('collect_expires_at')
                  .whereRaw("updated_at <= now() - interval '2 minutes'");
              })
              .orWhereRaw(
                `collect_expires_at <= now() - interval '${STUCK_COLLECT_MINUTES} minutes'`,
              );
          }),
        (row) =>
          row.bot_collect_id
            ? `collect request ${row.bot_collect_id}`
            : `memo sell:${row.id} (or a collect request with external_id ${row.id})`,
      ],
      [
        SellStatus.REFUNDING,
        (q) => void q.whereRaw("updated_at <= now() - interval '5 minutes'"),
        (row) => `memo sell-refund:${row.id}`,
      ],
    ];
    let count = 0;
    for (const [status, olderThan, lookFor] of stuck) {
      const rows = await this.knex<SellOrderRow>('sell_order')
        .where('status', status)
        .where(olderThan)
        .limit(50);
      for (const row of rows) {
        const parked = await this.setStatus(this.knex, row.id, [status], {
          status: SellStatus.NEEDS_REVIEW,
          failure_reason: `Stuck in ${status}${row.failure_reason ? ` (${row.failure_reason})` : ''}`,
        });
        if (!parked) continue;
        count++;
        await this.telegramLogger.logAlert(
          'Sell',
          `Sell order ${row.id} (${row.sats} sats, #UID${row.user_id}) was stuck in ${status}. ` +
            `Check the bot for ${lookFor(row)} to see whether it went through.`,
        );
      }
    }

    const outOfAttempts = await this.knex<SellOrderRow>('sell_order')
      .where('status', SellStatus.SATS_COLLECTED)
      .where('retry_count', '>=', MAX_PAYOUT_ATTEMPTS)
      .whereRaw(
        `updated_at <= now() - interval '${STUCK_PAYOUT_MINUTES} minutes'`,
      )
      .limit(50);
    for (const row of outOfAttempts) {
      const parked = await this.setStatus(
        this.knex,
        row.id,
        [SellStatus.SATS_COLLECTED],
        {
          status: SellStatus.NEEDS_REVIEW,
          failure_reason: `No payout after ${row.retry_count} attempts${row.failure_reason ? ` (${row.failure_reason})` : ''}`,
        },
      );
      if (!parked) continue;
      count++;
      await this.telegramLogger.logAlert(
        'Sell',
        `Sell order ${row.id} (${row.sats} sats, #UID${row.user_id}) used all ${row.retry_count} payout attempts and was left in SATS_COLLECTED. ` +
          `Sats are collected; check CeyPay for externalRef ${row.id} before paying out or refunding.`,
      );
    }
    return count;
  }

  /** Payouts CeyPay hasn't finished after this long are reported (once). */
  async alertStalePayouts(hours = 2): Promise<number> {
    const rows = await this.knex<SellOrderRow>('sell_order')
      .where('status', SellStatus.PAYOUT_PENDING)
      .whereNull('alerted_at')
      .whereRaw(`created_at <= now() - interval '${hours} hours'`)
      .limit(50);
    for (const row of rows) {
      await this.knex('sell_order')
        .where('id', row.id)
        .update({ alerted_at: this.knex.fn.now() });
      await this.telegramLogger.logAlert(
        'Sell',
        `Sell order ${row.id}: the CeyPay payout of ${row.amount_lkr} LKR (payment ${row.ceypay_payment_id ?? '-'}) is still pending after ${hours}h.`,
      );
    }
    return rows.length;
  }

  /**
   * Atomically count a payout attempt (FOR UPDATE SKIP LOCKED). Only when the
   * attempt is due: right after another claim (or confirm's own first
   * attempt) the backoff isn't over, so a second caller gets nothing.
   */
  private async claimForPayout(id: string): Promise<SellOrderRow | null> {
    return this.knex.transaction(async (trx) => {
      const order = await trx<SellOrderRow>('sell_order')
        .where({ id, status: SellStatus.SATS_COLLECTED })
        .whereNull('ceypay_payment_id')
        .where(payoutAttemptDue)
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
    // Inside a transaction the caller clears it after the commit
    if (row && !db.isTransaction) await this.clearHistoryCache(row.user_id);
    return row;
  }

  /** /transaction/list shows sales and is cached per member. Never throws. */
  private async clearHistoryCache(userId: string): Promise<void> {
    await this.redisService.delByPattern(
      CacheKeys.patterns.userTransactionLists(userId),
    );
  }
}
