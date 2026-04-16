import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import dayjs from 'dayjs';
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

interface CoinGecko24HrChangeResponse {
  bitcoin: {
    lkr: number;
    lkr_24h_change: number;
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
  private readonly CACHE_TTL_SECONDS = parseInt(
    process.env.BITCOIN_PRICE_CACHE_TTL || '20',
  );
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
      const usdLkrRate = await this.fetchUsdLkrRate();
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
      // Check Redis cache first (fresh data only)
      const cached = await this.getCachedBitcoinPrice();

      if (cached && this.isCacheValid(cached.timestamp)) {
        this.logger.debug(
          `Using fresh cached BTC/USD price: ${cached.price}`,
        );
        return cached.price;
      }

      // Try to fetch from API
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
        timeout: 10000,
      });

      const price = response.data?.bitcoin?.usd;

      if (typeof price !== 'number' || price <= 0) {
        this.logger.warn(
          `Invalid BTC/USD price received from CoinGecko: ${price}`,
        );
        // Fall back to stale cache if API returns invalid data
        if (cached?.price) {
          this.logger.warn(
            `Using stale cached BTC/USD price as fallback: ${cached.price}`,
          );
          return cached.price;
        }
        return null;
      }

      // Cache the fresh price
      await this.setCachedBitcoinPrice(price, new Date());
      this.logger.log(`Fetched fresh BTC/USD price: ${price}`);

      return price;
    } catch (error) {
      this.logger.error('CoinGecko API error for BTC/USD:', error);

      // FALLBACK: Try to use stale cache data when API is down
      const staleCache = await this.getCachedBitcoinPrice();

      if (staleCache?.price) {
        const ageMinutes = this.getCacheAgeMinutes(staleCache.timestamp);
        this.logger.warn(
          `CoinGecko API failed - using stale cached BTC/USD price: ${staleCache.price} (${ageMinutes} min old)`,
        );
        return staleCache.price;
      }

      return null;
    }
  }

  private async fetchUsdLkrRate(): Promise<number | null> {
    try {
      // Check Redis cache first (fresh data only)
      const cached = await this.getCachedUsdLkrRate();

      if (cached && this.isCacheValid(cached.timestamp)) {
        this.logger.debug(
          `Using fresh cached USD/LKR rate: ${cached.rate}`,
        );
        return cached.rate;
      }

      // Try to fetch from API
      const response: AxiosResponse<CeylonCashResponse> = await axios.get(
        'https://fx.ceyloncash.com/currency/USD',
        {
          timeout: 10000,
        },
      );

      const sellingRate = response.data?.selling_rate;

      if (typeof sellingRate !== 'number' || sellingRate <= 0) {
        this.logger.warn(
          `Invalid USD/LKR rate received from Ceylon Cash: ${sellingRate}`,
        );
        // Fall back to stale cache if API returns invalid data
        if (cached?.rate) {
          this.logger.warn(
            `Using stale cached USD/LKR rate as fallback: ${cached.rate}`,
          );
          return cached.rate;
        }
        return null;
      }

      // Cache the fresh rate
      await this.setCachedUsdLkrRate(sellingRate, new Date());
      this.logger.log(`Fetched fresh USD/LKR rate: ${sellingRate}`);

      return sellingRate;
    } catch (error) {
      this.logger.error('Ceylon Cash API error for USD/LKR:', error);

      // FALLBACK: Try to use stale cache data when API is down
      const staleCache = await this.getCachedUsdLkrRate();

      if (staleCache?.rate) {
        const ageMinutes = this.getCacheAgeMinutes(staleCache.timestamp);
        this.logger.warn(
          `Ceylon Cash API failed - using stale cached USD/LKR rate: ${staleCache.rate} (${ageMinutes} min old)`,
        );
        return staleCache.rate;
      }

      return null;
    }
  }

  private isCacheValid(timestamp: Date): boolean {
    const now = dayjs();
    const cacheTime = dayjs(timestamp);
    return now.diff(cacheTime, 'second') < this.CACHE_TTL_SECONDS;
  }

  /**
   * Get cached Bitcoin price in USD (returns null if not found)
   */
  private async getCachedBitcoinPrice(): Promise<{
    price: number;
    timestamp: Date;
  } | null> {
    try {
      const cacheKey = CacheKeys.bitcoin.price('USD');
      return await this.redisService.get<{
        price: number;
        timestamp: Date;
      }>(cacheKey);
    } catch (error) {
      this.logger.error('Error getting cached BTC/USD price:', error);
      return null;
    }
  }

  /**
   * Set cached Bitcoin price in USD (1 hour TTL)
   */
  private async setCachedBitcoinPrice(
    price: number,
    timestamp: Date,
  ): Promise<void> {
    try {
      const cacheKey = CacheKeys.bitcoin.price('USD');
      await this.redisService.set(
        cacheKey,
        { price, timestamp },
        { ttl: 3600 }, // 1 hour
      );
    } catch (error) {
      this.logger.error('Error setting cached BTC/USD price:', error);
    }
  }

  /**
   * Get cached USD/LKR exchange rate (returns null if not found)
   */
  private async getCachedUsdLkrRate(): Promise<{
    rate: number;
    timestamp: Date;
  } | null> {
    try {
      const cacheKey = CacheKeys.bitcoin.usdLkr();
      return await this.redisService.get<{
        rate: number;
        timestamp: Date;
      }>(cacheKey);
    } catch (error) {
      this.logger.error('Error getting cached USD/LKR rate:', error);
      return null;
    }
  }

  /**
   * Set cached USD/LKR exchange rate (1 hour TTL)
   */
  private async setCachedUsdLkrRate(
    rate: number,
    timestamp: Date,
  ): Promise<void> {
    try {
      const cacheKey = CacheKeys.bitcoin.usdLkr();
      await this.redisService.set(
        cacheKey,
        { rate, timestamp },
        { ttl: 3600 }, // 1 hour
      );
    } catch (error) {
      this.logger.error('Error setting cached USD/LKR rate:', error);
    }
  }

  /**
   * Calculate cache age in minutes
   */
  private getCacheAgeMinutes(timestamp: Date): number {
    return Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000);
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

  async getBitcoin24HrChange(): Promise<number | null> {
    try {
      // Check Redis cache first (10 minutes TTL)
      const cacheKey = CacheKeys.bitcoin.price24HrChange();
      const cached = await this.redisService.get<{
        change: number;
        timestamp: Date;
      }>(cacheKey);

      if (cached && this.is24HrCacheValid(cached.timestamp)) {
        this.logger.debug(
          `Using cached 24hr change from Redis: ${cached.change}%`,
        );
        return cached.change;
      }

      const apiKey = process.env.COINGECKO_API_KEY;
      const baseUrl = apiKey
        ? 'https://pro-api.coingecko.com/api/v3'
        : 'https://api.coingecko.com/api/v3';

      const url = `${baseUrl}/simple/price`;
      const params = {
        ids: 'bitcoin',
        vs_currencies: 'LKR',
        include_24hr_change: 'true',
      };

      const headers = apiKey ? { 'x-cg-pro-api-key': apiKey } : {};

      const response: AxiosResponse<CoinGecko24HrChangeResponse> =
        await axios.get(url, {
          params,
          headers,
          timeout: 10000, // 10 second timeout
        });

      const change = response.data?.bitcoin?.lkr_24h_change;

      if (typeof change !== 'number') {
        this.logger.warn(
          `Invalid 24hr change received from CoinGecko: ${String(change)}`,
        );
        return null;
      }

      // Cache the result in Redis for 10 minutes (600 seconds)
      const cacheData = { change, timestamp: new Date() };
      await this.redisService.set(cacheKey, cacheData, {
        ttl: 600, // 10 minutes
      });
      this.logger.log(`Fetched fresh 24hr change: ${change}%`);

      return change;
    } catch (error) {
      this.logger.error('CoinGecko API error for 24hr change:', error);
      return null;
    }
  }

  private is24HrCacheValid(timestamp: Date): boolean {
    const now = dayjs();
    const cacheTime = dayjs(timestamp);
    return now.diff(cacheTime, 'second') < 600; // 10 minutes
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
    const btcUsdCache = await this.redisService.get<{
      price: number;
      timestamp: Date;
    }>(CacheKeys.bitcoin.price('USD'));
    if (btcUsdCache) {
      status.btc_usd = {
        price: btcUsdCache.price,
        age_seconds: now.diff(dayjs(btcUsdCache.timestamp), 'second'),
      };
    }

    // Get USD/LKR cache status
    const usdLkrCache = await this.redisService.get<{
      rate: number;
      timestamp: Date;
    }>(CacheKeys.bitcoin.usdLkr());
    if (usdLkrCache) {
      status.usd_lkr = {
        rate: usdLkrCache.rate,
        age_seconds: now.diff(dayjs(usdLkrCache.timestamp), 'second'),
      };
    }

    return status;
  }
}
