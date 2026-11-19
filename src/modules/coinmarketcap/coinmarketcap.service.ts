import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import { errorMessage } from '../../common/error-message';

interface CoinMarketCapPriceResponse {
  data: Array<{
    id: number;
    price: number;
    percent_change_24h: number;
  }>;
  status: {
    timestamp: string;
    error_code: number | string;
    error_message: string;
  };
}

export type CoinMarketCapFailure = 'PERSISTENT' | 'TRANSIENT';

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
    const result = await this.fetchBitcoinDataResult();
    return 'data' in result ? result.data : null;
  }

  /**
   * BTC price and 24h change, or why not:
   * - PERSISTENT: won't fix itself soon - bad/missing key or plan (401/403),
   *   rate limit (429), or an API error code in the body
   * - TRANSIENT: timeout, connection reset, 5xx, or a bad payload
   * so callers can wait longer before retrying a persistent failure.
   */
  async fetchBitcoinDataResult(): Promise<
    { data: BitcoinMarketData } | { failure: CoinMarketCapFailure }
  > {
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

      // CMC documents error_code as a number; accept a numeric string too
      if (Number(response.data.status?.error_code) !== 0) {
        this.logger.warn(
          `CoinMarketCap API error: ${response.data.status.error_message}`,
        );
        return { failure: 'PERSISTENT' };
      }

      const entry = response.data.data?.[0];
      const { price, percent_change_24h } = entry ?? {};

      if (typeof price !== 'number' || price <= 0) {
        this.logger.warn(
          `Invalid BTC/USD price received from CoinMarketCap: ${price}`,
        );
        return { failure: 'TRANSIENT' };
      }

      return { data: { price, percent_change_24h } };
    } catch (error) {
      // One line: logging the AxiosError object dumps its sockets, TLS state
      // and agents (thousands of lines), which hit Railway's log rate limit
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      const persistent = status === 401 || status === 403 || status === 429;
      const hint =
        status === 401 || status === 403
          ? ' - check COINMARKETCAP_API_KEY'
          : status === 429
            ? ' - rate limited'
            : '';
      this.logger.error(
        `CoinMarketCap request failed${status ? ` (HTTP ${status})` : ''}: ${errorMessage(error)}${hint}`,
      );
      return { failure: persistent ? 'PERSISTENT' : 'TRANSIENT' };
    }
  }
}
