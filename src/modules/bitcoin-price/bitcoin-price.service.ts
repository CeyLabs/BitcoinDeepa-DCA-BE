import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios, { AxiosResponse } from 'axios';
import Big from 'big.js';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { CeyPayError, CeyPayService } from '../ceypay/ceypay.service';
import { CoinMarketCapService } from '../coinmarketcap/coinmarketcap.service';
import { errorMessage } from '../../common/error-message';

export interface BitcoinPriceData {
  btc_price: number;
  currency: string;
}

/** BTC/LKR and the two rates it is made of. */
export interface BtcLkrRate {
  /** LKR per BTC, rounded down to cents */
  btcLkr: number;
  /** Ceylon Cash BTC/USD */
  btcUsd: number;
  /** CeyPay USDT/LKR (USDT taken as 1 USD) */
  usdtLkr: number;
}

/** A rate read back from exchange_rate_log. */
export interface LoggedBtcLkrRate extends BtcLkrRate {
  /** exchange_rate_log.id */
  id: string;
  /** When it was recorded (the row's created_at) */
  loggedAt: Date;
}

/** Where a payment's price came from: the live feed or exchange_rate_log */
export type PriceSource = 'live' | 'log';

export interface SatoshiCalculation {
  satoshis: number;
  btc_price: number;
  currency: string;
  /** 'log' = the live price was down, priced from exchange_rate_log */
  source: PriceSource;
  /** When the price was taken: now (live) or the logged row's created_at */
  priced_at: Date;
  /** The exchange_rate_log row used, when source is 'log' */
  rate_log_id?: string;
}

/** fx.ceyloncash.com/currency/BTC */
interface CeylonCashBtcResponse {
  usd_price?: number;
}

/** Ceylon Cash BTC/USD is cached this long */
export const BTC_USD_CACHE_TTL_SECONDS = 30;
/**
 * CeyPay's USDT/LKR only changes every ~10 min, and each fetch is a quote
 * (a row in CeyPay's aggregator_fx_quote), so it is cached longer.
 */
export const USDT_LKR_CACHE_TTL_SECONDS = 300;
/** After a failed fetch, answer "unavailable" from cache for this long */
const FAILURE_CACHE_TTL_SECONDS = 10;
/** Price lookups sit on request paths: fail fast instead of hanging */
const PRICE_FETCH_TIMEOUT_MS = 3000;
/** CoinMarketCap 24h change (display only) */
const CHANGE_24H_CACHE_TTL_SECONDS = parseInt(
  process.env.BTC_PRICE_CACHE_TTL || '300',
  10,
);
const SATOSHIS_PER_BTC = 100_000_000;
/** One instance records the rate per minute (the claim outlives a late tick) */
const RATE_LOG_CLAIM_TTL_SECONDS = 50;
/**
 * Default for EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS. A row is written every
 * minute, so this covers two missed ticks; anything longer is a real outage
 * and the payment waits for the backfill cron.
 */
export const DEFAULT_FALLBACK_MAX_AGE_SECONDS = 180;
/**
 * The most EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS can be (validateEnv rejects
 * more): a payment priced from the log is settled automatically, so a typo
 * must not price it at an hours-old rate.
 */
export const MAX_FALLBACK_MAX_AGE_SECONDS = 900;

/**
 * How old a logged rate may be and still price a payment when the live price
 * is unavailable (EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS, 0 = never). Unset,
 * empty or out of range = the default.
 */
export const fallbackMaxAgeSeconds = (): number => {
  const raw = process.env.EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS?.trim();
  if (!raw) return DEFAULT_FALLBACK_MAX_AGE_SECONDS;
  const value = Number(raw);
  return Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_FALLBACK_MAX_AGE_SECONDS
    ? value
    : DEFAULT_FALLBACK_MAX_AGE_SECONDS;
};

// Integer division, rounded down (its own constructor: Big.DP/RM are global)
const BigFloor = Big();
BigFloor.DP = 0;
BigFloor.RM = Big.roundDown;

/**
 * Whole sats `amount` buys at `btcPrice` (same currency), rounded down.
 * Decimal arithmetic: with floats an exact result comes out one sat short
 * (128.70 LKR at 21,450,000 LKR/BTC is 600 sats, not 599).
 */
export const satoshisFor = (
  amount: number | string,
  btcPrice: number | string,
): number =>
  new BigFloor(amount).times(SATOSHIS_PER_BTC).div(btcPrice).toNumber();

const failureKey = (key: string): string => `${key}:failed`;

/**
 * LKR per BTC: BTC/USD × USDT/LKR (USDT taken as 1 USD), rounded down to
 * cents.
 */
export const btcLkrRate = (btcUsd: number, usdtLkr: number): number =>
  new Big(btcUsd).times(usdtLkr).round(2, Big.roundDown).toNumber();

/**
 * The one BTC/LKR price used everywhere (buy, DCA, sell, wallet):
 * Ceylon Cash BTC/USD × CeyPay's USDT/LKR, so our LKR matches what CeyPay
 * pays for the same USDT. CoinMarketCap is only used for the 24h change shown
 * on the wallet, never for a price.
 */
@Injectable()
export class BitcoinPriceService {
  private readonly logger = new Logger(BitcoinPriceService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly ceyPay: CeyPayService,
    private readonly coinMarketCap: CoinMarketCapService,
    private readonly knexService: KnexService,
  ) {}

  /** BTC/LKR with its parts; null when either rate is unavailable. Never throws. */
  async getBtcLkrRate(): Promise<BtcLkrRate | null> {
    const [btcUsd, usdtLkr] = await Promise.all([
      this.getBtcUsd(),
      this.getUsdtLkr().catch((error) => {
        this.logger.error(`CeyPay USDT/LKR rate: ${errorMessage(error)}`);
        return null;
      }),
    ]);
    if (!btcUsd || !usdtLkr) return null;
    return { btcLkr: btcLkrRate(btcUsd, usdtLkr), btcUsd, usdtLkr };
  }

  async getBitcoinPrice(currency: string): Promise<BitcoinPriceData | null> {
    if (currency.toUpperCase() !== 'LKR') {
      this.logger.warn(
        `Currency ${currency} not supported. Only LKR is supported.`,
      );
      return null;
    }

    const rate = await this.getBtcLkrRate();
    return rate ? { btc_price: rate.btcLkr, currency: 'LKR' } : null;
  }

  /**
   * Sats for a buy/DCA payment. Priced live; when the live price is
   * unavailable, from the latest exchange_rate_log row if it is recent enough
   * (see getRecentLoggedRate). Null when there is neither. `source` and
   * `priced_at` say which it was, so the caller can record it.
   */
  async calculateSatoshis(
    amount: number,
    currency: string,
  ): Promise<SatoshiCalculation | null> {
    const live = await this.getBitcoinPrice(currency);
    if (live) {
      return {
        satoshis: satoshisFor(amount, live.btc_price),
        btc_price: live.btc_price,
        currency: live.currency,
        source: 'live',
        priced_at: new Date(),
      };
    }
    if (currency.toUpperCase() !== 'LKR') return null;

    const logged = await this.getRecentLoggedRate();
    if (!logged) return null;
    return {
      satoshis: satoshisFor(amount, logged.btcLkr),
      btc_price: logged.btcLkr,
      currency: 'LKR',
      source: 'log',
      priced_at: logged.loggedAt,
      rate_log_id: logged.id,
    };
  }

  /**
   * Append the current rate to exchange_rate_log as the one active row
   * (the previous one is deactivated), once a minute across instances.
   * Nothing is written while a rate is unavailable, so the active row's age
   * says how long the outage has lasted. (The rate can be up to the cache
   * TTLs older than its created_at: 30s for BTC/USD.) Like the backfill
   * cron, it does nothing while ENABLE_BITCOIN_TRACKING is off: no payment is
   * priced then, so there is nothing to fetch rates for.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async recordExchangeRate(): Promise<void> {
    if (process.env.ENABLE_BITCOIN_TRACKING === 'false') return;
    try {
      const claimed = await this.redisService.setIfAbsent(
        CacheKeys.bitcoin.rateLogClaim(),
        RATE_LOG_CLAIM_TTL_SECONDS,
      );
      if (!claimed) return;
      const rate = await this.getBtcLkrRate();
      if (!rate) return;
      await this.knexService.knex.transaction(async (trx) => {
        // One writer at a time: two instances deactivating and inserting
        // together would both insert an active row (unique index violation)
        await trx.raw(
          "SELECT pg_advisory_xact_lock(hashtext('exchange_rate_log'))",
        );
        await trx('exchange_rate_log')
          .where('is_active', true)
          .update({ is_active: false });
        await trx('exchange_rate_log').insert({
          btc_usd: rate.btcUsd,
          usdt_lkr: rate.usdtLkr,
          btc_lkr: rate.btcLkr,
          is_active: true,
        });
      });
    } catch (error) {
      this.logger.error(`Recording the exchange rate: ${errorMessage(error)}`);
    }
  }

  /**
   * The active logged rate, if it is at most
   * EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS old. Only for pricing a payment
   * that has already been made while the live price is down - quotes and
   * displayed prices stay live. Null when there is none. Never throws.
   */
  async getRecentLoggedRate(): Promise<LoggedBtcLkrRate | null> {
    const maxAge = fallbackMaxAgeSeconds();
    if (maxAge === 0) return null;
    try {
      const row = await this.knexService
        .knex('exchange_rate_log')
        .select(
          'id',
          'btc_usd',
          'usdt_lkr',
          'btc_lkr',
          'created_at',
          this.knexService.knex.raw(
            'extract(epoch from now() - created_at)::int as age_seconds',
          ),
        )
        .where('is_active', true)
        .where(
          'created_at',
          '>=',
          this.knexService.knex.raw('now() - make_interval(secs => ?)', [
            maxAge,
          ]),
        )
        .first<{
          id: string;
          btc_usd: string;
          usdt_lkr: string;
          btc_lkr: string;
          created_at: Date;
          age_seconds: number;
        }>();
      if (!row) return null;
      this.logger.warn(
        `Live BTC/LKR unavailable: using exchange_rate_log #${row.id}, logged ${row.age_seconds}s ago (${row.btc_lkr} LKR/BTC)`,
      );
      return {
        id: String(row.id),
        loggedAt: new Date(row.created_at),
        btcLkr: Number(row.btc_lkr),
        btcUsd: Number(row.btc_usd),
        usdtLkr: Number(row.usdt_lkr),
      };
    } catch (error) {
      this.logger.error(
        `Reading the logged exchange rate: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * BTC's 24h % change from CoinMarketCap, for display only (cached).
   * Null when unavailable.
   */
  async getBitcoin24HrChange(): Promise<number | null> {
    const data = await this.redisService.getOrSet(
      CacheKeys.bitcoin.cmc24hChange(),
      CHANGE_24H_CACHE_TTL_SECONDS,
      async () => {
        const btc = await this.coinMarketCap.fetchBitcoinData();
        return btc ? { change: btc.percent_change_24h } : null;
      },
    );
    return data?.change ?? null;
  }

  /** BTC/USD from Ceylon Cash FX (cached). Null when unavailable or invalid. */
  getBtcUsd(): Promise<number | null> {
    return this.cached(
      CacheKeys.bitcoin.ceylonCashBtcUsd(),
      BTC_USD_CACHE_TTL_SECONDS,
      async () => {
        try {
          const response: AxiosResponse<CeylonCashBtcResponse> =
            await axios.get('https://fx.ceyloncash.com/currency/BTC', {
              timeout: PRICE_FETCH_TIMEOUT_MS,
            });
          const usd = response.data?.usd_price;
          if (typeof usd !== 'number' || !(usd > 0)) {
            this.logger.warn(`Invalid BTC/USD price from Ceylon Cash: ${usd}`);
            return null;
          }
          return usd;
        } catch (error) {
          this.logger.error(
            `Ceylon Cash API error for BTC/USD: ${errorMessage(error)}`,
          );
          return null;
        }
      },
    );
  }

  /** CeyPay's current USDT/LKR rate (cached). Throws when it has none. */
  async getUsdtLkr(): Promise<number> {
    let failure: unknown;
    const rate = await this.cached(
      CacheKeys.bitcoin.ceypayUsdtLkr(),
      USDT_LKR_CACHE_TTL_SECONDS,
      async () => {
        try {
          const quote = await this.ceyPay.getQuote('1', {
            timeoutMs: PRICE_FETCH_TIMEOUT_MS,
          });
          return quote.rateUsdtLkr > 0 ? quote.rateUsdtLkr : null;
        } catch (error) {
          failure = error;
          return null;
        }
      },
    );
    if (!rate) {
      if (failure instanceof CeyPayError) throw failure;
      throw new CeyPayError(
        failure ? errorMessage(failure) : 'CeyPay returned no rate',
        undefined,
        true,
      );
    }
    return rate;
  }

  /** Replace the cached USDT/LKR rate with a fresher one (e.g. from a quote). */
  async setUsdtLkr(rate: number): Promise<void> {
    await this.redisService.set(CacheKeys.bitcoin.ceypayUsdtLkr(), rate, {
      ttl: USDT_LKR_CACHE_TTL_SECONDS,
    });
    await this.redisService.del(failureKey(CacheKeys.bitcoin.ceypayUsdtLkr()));
  }

  /**
   * getOrSet that also remembers a failure for FAILURE_CACHE_TTL_SECONDS, so
   * an outage costs one slow call per window instead of one per request.
   */
  private async cached<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    if (await this.redisService.get<boolean>(failureKey(key))) return null;
    const value = await this.redisService.getOrSet(key, ttlSeconds, loader);
    if (value === null) {
      await this.redisService.set(failureKey(key), true, {
        ttl: FAILURE_CACHE_TTL_SECONDS,
      });
    }
    return value;
  }

  async clearCache(): Promise<void> {
    await this.redisService.delByPattern(CacheKeys.patterns.allBitcoinPrices());
    this.logger.log('Bitcoin price cache cleared from Redis');
  }
}
