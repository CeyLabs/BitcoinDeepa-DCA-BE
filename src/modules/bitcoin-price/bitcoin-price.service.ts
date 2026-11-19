import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { CoinMarketCapService } from '../coinmarketcap/coinmarketcap.service';
import { errorMessage } from '../../common/error-message';

export interface BitcoinPriceData {
  btc_price: number;
  currency: string;
}

interface CeylonCashResponse {
  selling_rate: number;
}

/** fx.ceyloncash.com/currency/BTC */
interface CeylonCashBtcResponse {
  buying_rate_lkr?: number;
  selling_rate_lkr?: number;
  usd_price?: number;
}

interface BitcoinCacheData {
  price: number;
  percent_change_24h: number;
}

@Injectable()
export class BitcoinPriceService {
  private readonly logger = new Logger(BitcoinPriceService.name);
  private readonly BTC_PRICE_CACHE_TTL_SECONDS = parseInt(
    process.env.BTC_PRICE_CACHE_TTL || '300',
    10,
  );
  private readonly USD_LKR_CACHE_TTL_SECONDS = parseInt(
    process.env.USD_LKR_CACHE_TTL || '20',
    10,
  );
  private readonly BTC_SELL_RATE_CACHE_TTL_SECONDS = 30;
  private readonly SATOSHIS_PER_BTC = 100_000_000;

  constructor(
    private readonly redisService: RedisService,
    private readonly coinMarketCapService: CoinMarketCapService,
  ) {}

  async getBitcoinPrice(currency: string): Promise<BitcoinPriceData | null> {
    if (currency.toUpperCase() !== 'LKR') {
      this.logger.warn(
        `Currency ${currency} not supported. Only LKR is supported.`,
      );
      return null;
    }

    const price = await this.getCurrentPrice();
    return price ? { btc_price: price.lkr, currency: 'LKR' } : null;
  }

  async calculateSatoshis(
    amount: number,
    currency: string,
  ): Promise<{ satoshis: number; btc_price: number; currency: string } | null> {
    const priceData = await this.getBitcoinPrice(currency);
    if (!priceData) return null;

    return {
      satoshis: Math.floor(
        (amount / priceData.btc_price) * this.SATOSHIS_PER_BTC,
      ),
      btc_price: priceData.btc_price,
      currency: priceData.currency,
    };
  }

  async getBitcoin24HrChange(): Promise<number | null> {
    const data = await this.getBitcoinMarketData();
    return data?.percent_change_24h ?? null;
  }

  /** BTC price in USD and LKR (BTC/USD from CoinMarketCap × USD/LKR). */
  async getCurrentPrice(): Promise<{
    usd: number;
    lkr: number;
    timestamp: Date;
  } | null> {
    const btc = await this.getBitcoinMarketData();
    if (!btc) return null;

    const usdLkrRate = await this.getUsdLkrRate();
    if (!usdLkrRate) return null;

    return {
      usd: btc.price,
      lkr: btc.price * usdLkrRate,
      timestamp: new Date(),
    };
  }

  /**
   * BTC/USD from our own Ceylon Cash FX (sell flow; the LKR side comes from
   * CeyPay's USDT/LKR rate). Cached briefly; null when unavailable or invalid.
   */
  getBtcUsdSellPrice(): Promise<number | null> {
    return this.redisService.getOrSet(
      CacheKeys.bitcoin.ceylonCashBtcUsd(),
      this.BTC_SELL_RATE_CACHE_TTL_SECONDS,
      async () => {
        try {
          const response: AxiosResponse<CeylonCashBtcResponse> =
            await axios.get('https://fx.ceyloncash.com/currency/BTC', {
              timeout: 10000,
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

  private getBitcoinMarketData(): Promise<BitcoinCacheData | null> {
    return this.redisService.getOrSet(
      CacheKeys.bitcoin.price('USD'),
      this.BTC_PRICE_CACHE_TTL_SECONDS,
      async () => {
        const data = await this.coinMarketCapService.fetchBitcoinData();
        if (!data) return null;
        this.logger.log(
          `Fetched fresh BTC data: price=${data.price}, 24hr_change=${data.percent_change_24h}%`,
        );
        return {
          price: data.price,
          percent_change_24h: data.percent_change_24h,
        };
      },
    );
  }

  private async getUsdLkrRate(): Promise<number | null> {
    const cached = await this.redisService.getOrSet(
      CacheKeys.bitcoin.usdLkr(),
      this.USD_LKR_CACHE_TTL_SECONDS,
      async () => {
        try {
          const response: AxiosResponse<CeylonCashResponse> = await axios.get(
            'https://fx.ceyloncash.com/currency/USD',
            { timeout: 10000 },
          );
          const rate = response.data?.selling_rate;
          if (typeof rate !== 'number' || rate <= 0) {
            this.logger.warn(`Invalid USD/LKR rate from Ceylon Cash: ${rate}`);
            return null;
          }
          return { rate };
        } catch (error) {
          this.logger.error(
            `Ceylon Cash API error for USD/LKR: ${errorMessage(error)}`,
          );
          return null;
        }
      },
    );
    return cached?.rate ?? null;
  }

  async clearCache(): Promise<void> {
    await this.redisService.delByPattern(CacheKeys.patterns.allBitcoinPrices());
    this.logger.log('Bitcoin price cache cleared from Redis');
  }
}
