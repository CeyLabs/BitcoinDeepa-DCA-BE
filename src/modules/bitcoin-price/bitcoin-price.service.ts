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
  private btcUsdCache: { price: number; timestamp: Date } | null = null;
  private usdLkrCache: { rate: number; timestamp: Date } | null = null;
  private readonly CACHE_TTL_SECONDS = 20; // Cache frequency
  private readonly SATOSHIS_PER_BTC = 100_000_000;

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
      // Check cache first
      if (this.btcUsdCache && this.isCacheValid(this.btcUsdCache.timestamp)) {
        this.logger.debug(
          `Using cached BTC/USD price: ${this.btcUsdCache.price}`,
        );
        return this.btcUsdCache.price;
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

      // Cache the result
      this.btcUsdCache = { price, timestamp: new Date() };
      this.logger.log(`Fetched fresh BTC/USD price: ${price}`);

      return price;
    } catch (error) {
      this.logger.error('CoinGecko API error for BTC/USD:', error);
      return null;
    }
  }

  private async fetchUSDLKRRate(): Promise<number | null> {
    try {
      // Check cache first
      if (this.usdLkrCache && this.isCacheValid(this.usdLkrCache.timestamp)) {
        this.logger.debug(
          `Using cached USD/LKR rate: ${this.usdLkrCache.rate}`,
        );
        return this.usdLkrCache.rate;
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

      // Cache the result
      this.usdLkrCache = { rate: sellingRate, timestamp: new Date() };
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
  clearCache(): void {
    this.btcUsdCache = null;
    this.usdLkrCache = null;
    this.logger.log('Bitcoin price cache cleared');
  }

  // Get cache status for debugging
  getCacheStatus(): {
    btc_usd?: { price: number; age_seconds: number };
    usd_lkr?: { rate: number; age_seconds: number };
  } {
    const now = dayjs();
    const status: {
      btc_usd?: { price: number; age_seconds: number };
      usd_lkr?: { rate: number; age_seconds: number };
    } = {};

    if (this.btcUsdCache) {
      status.btc_usd = {
        price: this.btcUsdCache.price,
        age_seconds: now.diff(dayjs(this.btcUsdCache.timestamp), 'second'),
      };
    }

    if (this.usdLkrCache) {
      status.usd_lkr = {
        rate: this.usdLkrCache.rate,
        age_seconds: now.diff(dayjs(this.usdLkrCache.timestamp), 'second'),
      };
    }

    return status;
  }
}
