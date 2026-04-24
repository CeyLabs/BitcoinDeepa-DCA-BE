import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { CoinMarketCapService } from '../coinmarketcap/coinmarketcap.service';

export interface BitcoinPriceData {
  btc_price: number;
  currency: string;
  satoshis_per_amount: number;
}

interface CeylonCashResponse {
  selling_rate: number;
}

interface BitcoinCacheData {
  price: number;
  percent_change_24h: number;
}

@Injectable()
export class BitcoinPriceService {
  private readonly logger = new Logger(BitcoinPriceService.name);
  private readonly BTC_PRICE_CACHE_TTL_SECONDS = 300; // 5 minutes
  private readonly USD_LKR_CACHE_TTL_SECONDS = parseInt(
    process.env.BITCOIN_PRICE_CACHE_TTL || '20',
  );
  private readonly SATOSHIS_PER_BTC = 100_000_000;

  constructor(
    private readonly redisService: RedisService,
    private readonly coinMarketCapService: CoinMarketCapService,
  ) {}

  async getBitcoinPrice(currency: string): Promise<BitcoinPriceData | null> {
    try {
      if (currency.toUpperCase() !== 'LKR') {
        this.logger.warn(
          `Currency ${currency} not supported. Only LKR is supported.`,
        );
        return null;
      }

      const btcUsdPrice = await this.fetchBitcoinPriceInUSD();
      if (!btcUsdPrice) return null;

      const usdLkrRate = await this.fetchUsdLkrRate();
      if (!usdLkrRate) return null;

      const btcLkrPrice = btcUsdPrice * usdLkrRate;
      this.logger.log(
        `BTC price calculated: ${btcUsdPrice} USD * ${usdLkrRate} LKR/USD = ${btcLkrPrice} LKR`,
      );

      return {
        btc_price: btcLkrPrice,
        currency: 'LKR',
        satoshis_per_amount: this.SATOSHIS_PER_BTC / btcLkrPrice,
      };
    } catch (error) {
      this.logger.error(`Failed to get Bitcoin price for ${currency}:`, error);
      return null;
    }
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

  private async fetchBitcoinPriceInUSD(): Promise<number | null> {
    const data = await this.getOrFetchBitcoinData();
    return data?.price ?? null;
  }

  async getBitcoin24HrChange(): Promise<number | null> {
    const data = await this.getOrFetchBitcoinData();
    return data?.percent_change_24h ?? null;
  }

  private async getOrFetchBitcoinData(): Promise<BitcoinCacheData | null> {
    const cached = await this.getCachedBitcoinData();
    if (cached) return cached;

    try {
      const data = await this.coinMarketCapService.fetchBitcoinData();

      if (!data || typeof data.price !== 'number' || data.price <= 0) {
        this.logger.warn(
          `Invalid BTC data received from CoinMarketCap: ${JSON.stringify(data)}`,
        );
        return null;
      }

      const cacheData: BitcoinCacheData = {
        price: data.price,
        percent_change_24h: data.percent_change_24h,
      };

      await this.setCachedBitcoinData(cacheData);
      this.logger.log(
        `Fetched fresh BTC data: price=${data.price}, 24hr_change=${data.percent_change_24h}%`,
      );

      return cacheData;
    } catch (error) {
      this.logger.error('CoinMarketCap API error:', error);
      return null;
    }
  }

  private async getCachedBitcoinData(): Promise<BitcoinCacheData | null> {
    try {
      return await this.redisService.get<BitcoinCacheData>(
        CacheKeys.bitcoin.price('USD'),
      );
    } catch (error) {
      this.logger.error('Error getting cached BTC data:', error);
      return null;
    }
  }

  private async setCachedBitcoinData(data: BitcoinCacheData): Promise<void> {
    try {
      await this.redisService.set(CacheKeys.bitcoin.price('USD'), data, {
        ttl: this.BTC_PRICE_CACHE_TTL_SECONDS,
      });
    } catch (error) {
      this.logger.error('Error setting cached BTC data:', error);
    }
  }

  private async fetchUsdLkrRate(): Promise<number | null> {
    const cached = await this.redisService.get<{ rate: number }>(
      CacheKeys.bitcoin.usdLkr(),
    );
    if (cached) {
      this.logger.debug(`Using cached USD/LKR rate: ${cached.rate}`);
      return cached.rate;
    }

    try {
      const response: AxiosResponse<CeylonCashResponse> = await axios.get(
        'https://fx.ceyloncash.com/currency/USD',
        { timeout: 10000 },
      );

      const sellingRate = response.data?.selling_rate;

      if (typeof sellingRate !== 'number' || sellingRate <= 0) {
        this.logger.warn(
          `Invalid USD/LKR rate received from Ceylon Cash: ${sellingRate}`,
        );
        return null;
      }

      await this.redisService.set(
        CacheKeys.bitcoin.usdLkr(),
        { rate: sellingRate },
        { ttl: this.USD_LKR_CACHE_TTL_SECONDS },
      );
      this.logger.log(`Fetched fresh USD/LKR rate: ${sellingRate}`);

      return sellingRate;
    } catch (error) {
      this.logger.error('Ceylon Cash API error for USD/LKR:', error);
      return null;
    }
  }

  async clearCache(): Promise<void> {
    await this.redisService.delByPattern(CacheKeys.patterns.allBitcoinPrices());
    this.logger.log('Bitcoin price cache cleared from Redis');
  }
}
