import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import Big from 'big.js';
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

  async calculateSatoshis(
    amount: number,
    currency: string,
  ): Promise<{ satoshis: number; btc_price: number; currency: string } | null> {
    const priceData = await this.getBitcoinPrice(currency);
    if (!priceData) return null;

    return {
      satoshis: satoshisFor(amount, priceData.btc_price),
      btc_price: priceData.btc_price,
      currency: priceData.currency,
    };
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
