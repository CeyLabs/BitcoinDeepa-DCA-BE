import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import * as dayjs from 'dayjs';

export interface BitcoinPriceData {
  btc_price: number;
  currency: string;
  timestamp: Date;
  satoshis_per_amount: number;
}

interface CoinGeckoResponse {
  bitcoin: {
    [currency: string]: number;
  };
}

@Injectable()
export class BitcoinPriceService {
  private readonly logger = new Logger(BitcoinPriceService.name);
  private priceCache = new Map<string, { price: number; timestamp: Date }>();
  private readonly CACHE_TTL_SECONDS = 20; // CoinGecko cache frequency
  private readonly SATOSHIS_PER_BTC = 100_000_000;

  async getBitcoinPrice(currency: string): Promise<BitcoinPriceData | null> {
    try {
      const cacheKey = currency.toLowerCase();
      const cached = this.priceCache.get(cacheKey);

      // Check if we have valid cached data
      if (cached && this.isCacheValid(cached.timestamp)) {
        this.logger.debug(
          `Using cached Bitcoin price for ${currency}: ${cached.price}`,
        );
        return this.createPriceData(cached.price, currency, cached.timestamp);
      }

      // Fetch fresh price from CoinGecko
      const price = await this.fetchBitcoinPriceFromAPI(currency);
      if (price) {
        const timestamp = new Date();
        this.priceCache.set(cacheKey, { price, timestamp });
        this.logger.log(
          `Fetched fresh Bitcoin price for ${currency}: ${price}`,
        );
        return this.createPriceData(price, currency, timestamp);
      }

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

  private async fetchBitcoinPriceFromAPI(
    currency: string,
  ): Promise<number | null> {
    try {
      const apiKey = process.env.COINGECKO_API_KEY;
      const baseUrl = apiKey
        ? 'https://pro-api.coingecko.com/api/v3'
        : 'https://api.coingecko.com/api/v3';

      const url = `${baseUrl}/simple/price`;
      const params = {
        ids: 'bitcoin',
        vs_currencies: currency.toLowerCase(),
        include_last_updated_at: 'true',
      };

      const headers = apiKey ? { 'x-cg-pro-api-key': apiKey } : {};

      const response: AxiosResponse<CoinGeckoResponse> = await axios.get(url, {
        params,
        headers,
        timeout: 10000, // 10 second timeout
      });

      const price = response.data?.bitcoin?.[currency.toLowerCase()];

      if (typeof price !== 'number' || price <= 0) {
        this.logger.warn(
          `Invalid price received from CoinGecko for ${currency}: ${price}`,
        );
        return null;
      }

      return price;
    } catch (error) {
      this.logger.error(`CoinGecko API error for ${currency}:`, error);
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
  clearCache(): void {
    this.priceCache.clear();
    this.logger.log('Bitcoin price cache cleared');
  }

  // Get cache status for debugging
  getCacheStatus(): { currency: string; price: number; age_seconds: number }[] {
    const now = dayjs();
    return Array.from(this.priceCache.entries()).map(([currency, data]) => ({
      currency,
      price: data.price,
      age_seconds: now.diff(dayjs(data.timestamp), 'second'),
    }));
  }
}
