import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';

interface CoinMarketCapPriceResponse {
  data: Array<{
    id: number;
    price: number;
    percent_change_24h: number;
  }>;
  status: {
    timestamp: string;
    error_code: string;
    error_message: string;
  };
}

export interface BitcoinMarketData {
  price: number;
  percent_change_24h: number;
}

@Injectable()
export class CoinMarketCapService {
  private readonly logger = new Logger(CoinMarketCapService.name);
  private readonly BASE_URL = 'https://pro-api.coinmarketcap.com';
  private readonly BITCOIN_ID = 1;

  private get headers(): Record<string, string> {
    const key = process.env.COINMARKETCAP_API_KEY;
    return key ? { 'X-CMC_PRO_API_KEY': key } : {};
  }

  async fetchBitcoinData(): Promise<BitcoinMarketData | null> {
    try {
      const response: AxiosResponse<CoinMarketCapPriceResponse> =
        await axios.get(`${this.BASE_URL}/v1/simple/price`, {
          params: {
            ids: this.BITCOIN_ID,
            include_percent_change_24h: true,
          },
          headers: this.headers,
          timeout: 10000,
        });

      if (response.data.status.error_code !== '0') {
        this.logger.warn(
          `CoinMarketCap API error: ${response.data.status.error_message}`,
        );
        return null;
      }

      const entry = response.data.data?.[0];
      const { price, percent_change_24h } = entry ?? {};

      if (typeof price !== 'number' || price <= 0) {
        this.logger.warn(
          `Invalid BTC/USD price received from CoinMarketCap: ${price}`,
        );
        return null;
      }

      return { price, percent_change_24h };
    } catch (error) {
      this.logger.error('CoinMarketCap API error:', error);
      return null;
    }
  }
}
