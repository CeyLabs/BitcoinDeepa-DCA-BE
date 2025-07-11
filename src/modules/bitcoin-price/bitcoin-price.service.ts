import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import * as dayjs from 'dayjs';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';

export interface BitcoinPriceData {
  btc_price: number;
  currency: string;
  timestamp: Date;
  satoshis_per_amount: number;
}

interface CoinGeckoResponse {
  bitcoin: {
    usd: number;
  };
}

interface CeylonCashResponse {
  description: string;
  buying_rate: number;
  selling_rate: number;
  cheque_buying_rate: number;
  cheque_selling_rate: number;
  telegraphic_transfers_buying_rate: number;
  telegraphic_transfers_selling_rate: number;
}

@Injectable()
export class BitcoinPriceService {
  private readonly logger = new Logger(BitcoinPriceService.name);
  private readonly CACHE_TTL_SECONDS = parseInt(process.env.BITCOIN_PRICE_CACHE_TTL || '20');
  private readonly SATOSHIS_PER_BTC = 100_000_000;

  constructor(private readonly redisService: RedisService) {}

  async getBitcoinPrice(currency: string): Promise<BitcoinPriceData | null> {
    try {
      const currencyUpper = currency.toUpperCase();

      // For LKR, use USD Bitcoin price + USD/LKR conversion
      if (currencyUpper === 'LKR') {
        return await this.getBitcoinPriceInLKR();
      }

      // For other currencies, fall back to direct CoinGecko API (if needed)
      this.logger.warn(
        `Currency ${currency} not supported. Only LKR is supported.`,
      );
      return null;
    } catch (error) {
      this.logger.error(`Failed to get Bitcoin price for ${currency}:`, error);
      return null;
    }
  }

  async calculateSatoshis(
    amount: number,
    currency: string,
  ): Promise<{
    satoshis: number;
    btc_price: number;
    currency: string;
    timestamp: Date;
  } | null> {
    const priceData = await this.getBitcoinPrice(currency);

    if (!priceData) {
      return null;
    }

    const satoshis = Math.floor(
      (amount / priceData.btc_price) * this.SATOSHIS_PER_BTC,
    );

    return {
      satoshis,
      btc_price: priceData.btc_price,
      currency: priceData.currency,
      timestamp: priceData.timestamp,
    };
  }

  private async getBitcoinPriceInLKR(): Promise<BitcoinPriceData | null> {
    try {
      // Get BTC/USD price from CoinGecko
      const btcUsdPrice = await this.fetchBitcoinPriceInUSD();
      if (!btcUsdPrice) {
        return null;
      }

      // Get USD/LKR exchange rate from Ceylon Cash
      const usdLkrRate = await this.fetchUSDLKRRate();
      if (!usdLkrRate) {
        return null;
      }

      // Calculate BTC price in LKR
      const btcLkrPrice = btcUsdPrice * usdLkrRate;
      const timestamp = new Date();

      this.logger.log(
        `BTC price calculated: ${btcUsdPrice} USD * ${usdLkrRate} LKR/USD = ${btcLkrPrice} LKR`,
      );

      return this.createPriceData(btcLkrPrice, 'LKR', timestamp);
    } catch (error) {
      this.logger.error('Failed to get Bitcoin price in LKR:', error);
      return null;
    }
  }

  private async fetchBitcoinPriceInUSD(): Promise<number | null> {
    try {
      // Check Redis cache first
      const cacheKey = CacheKeys.bitcoin.price('USD');
      const cached = await this.redisService.get<{price: number; timestamp: Date}>(cacheKey);
      
      if (cached && this.isCacheValid(cached.timestamp)) {
        this.logger.debug(
          `Using cached BTC/USD price from Redis: ${cached.price}`,
        );
        return cached.price;
      }

      const apiKey = process.env.COINGECKO_API_KEY;
      const baseUrl = apiKey
        ? 'https://pro-api.coingecko.com/api/v3'
        : 'https://api.coingecko.com/api/v3';

      const url = `${baseUrl}/simple/price`;
      const params = {
        ids: 'bitcoin',
        vs_currencies: 'usd',
        include_last_updated_at: 'true',
      };

      const headers = apiKey ? { 'x-cg-pro-api-key': apiKey } : {};

      const response: AxiosResponse<CoinGeckoResponse> = await axios.get(url, {
        params,
        headers,
        timeout: 10000, // 10 second timeout
      });

      const price = response.data?.bitcoin?.usd;

      if (typeof price !== 'number' || price <= 0) {
        this.logger.warn(
          `Invalid BTC/USD price received from CoinGecko: ${price}`,
        );
        return null;
      }

      // Cache the result in Redis
      const cacheData = { price, timestamp: new Date() };
      await this.redisService.set(cacheKey, cacheData, { ttl: this.CACHE_TTL_SECONDS });
      this.logger.log(`Fetched fresh BTC/USD price: ${price}`);

      return price;
    } catch (error) {
      this.logger.error('CoinGecko API error for BTC/USD:', error);
      return null;
    }
  }

  private async fetchUSDLKRRate(): Promise<number | null> {
    try {
      // Check Redis cache first
      const cacheKey = CacheKeys.bitcoin.usdLkr();
      const cached = await this.redisService.get<{rate: number; timestamp: Date}>(cacheKey);
      
      if (cached && this.isCacheValid(cached.timestamp)) {
        this.logger.debug(
          `Using cached USD/LKR rate from Redis: ${cached.rate}`,
        );
        return cached.rate;
      }

      const response: AxiosResponse<CeylonCashResponse> = await axios.get(
        'https://fx.ceyloncash.com/currency/USD',
        {
          timeout: 10000, // 10 second timeout
        },
      );

      const sellingRate = response.data?.selling_rate;

      if (typeof sellingRate !== 'number' || sellingRate <= 0) {
        this.logger.warn(
          `Invalid USD/LKR rate received from Ceylon Cash: ${sellingRate}`,
        );
        return null;
      }

      // Cache the result in Redis
      const cacheData = { rate: sellingRate, timestamp: new Date() };
      await this.redisService.set(cacheKey, cacheData, { ttl: this.CACHE_TTL_SECONDS });
      this.logger.log(`Fetched fresh USD/LKR rate: ${sellingRate}`);

      return sellingRate;
    } catch (error) {
      this.logger.error('Ceylon Cash API error for USD/LKR:', error);
      return null;
    }
  }

  private isCacheValid(timestamp: Date): boolean {
    const now = dayjs();
    const cacheTime = dayjs(timestamp);
    return now.diff(cacheTime, 'second') < this.CACHE_TTL_SECONDS;
  }

  private createPriceData(
    price: number,
    currency: string,
    timestamp: Date,
  ): BitcoinPriceData {
    return {
      btc_price: price,
      currency: currency.toUpperCase(),
      timestamp,
      satoshis_per_amount: this.SATOSHIS_PER_BTC / price,
    };
  }

  // Clear cache manually if needed
  async clearCache(): Promise<void> {
    await this.redisService.delByPattern(CacheKeys.patterns.allBitcoinPrices());
    this.logger.log('Bitcoin price cache cleared from Redis');
  }

  // Get cache status for debugging
  async getCacheStatus(): Promise<{
    btc_usd?: { price: number; age_seconds: number };
    usd_lkr?: { rate: number; age_seconds: number };
  }> {
    const now = dayjs();
    const status: {
      btc_usd?: { price: number; age_seconds: number };
      usd_lkr?: { rate: number; age_seconds: number };
    } = {};

    // Get BTC/USD cache status
    const btcUsdCache = await this.redisService.get<{price: number; timestamp: Date}>(
      CacheKeys.bitcoin.price('USD')
    );
    if (btcUsdCache) {
      status.btc_usd = {
        price: btcUsdCache.price,
        age_seconds: now.diff(dayjs(btcUsdCache.timestamp), 'second'),
      };
    }

    // Get USD/LKR cache status  
    const usdLkrCache = await this.redisService.get<{rate: number; timestamp: Date}>(
      CacheKeys.bitcoin.usdLkr()
    );
    if (usdLkrCache) {
      status.usd_lkr = {
        rate: usdLkrCache.rate,
        age_seconds: now.diff(dayjs(usdLkrCache.timestamp), 'second'),
      };
    }

    return status;
  }
}
