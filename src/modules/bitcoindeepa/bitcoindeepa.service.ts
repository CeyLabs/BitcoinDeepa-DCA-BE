import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import axios from 'axios';
import { DatabaseLoggerService } from '../knex/database-logger.service';

export interface FundTransferRequest {
  amount: number; // satoshis
  to: string; // Telegram user ID
  memo: string; // Transfer memo/description
}

export interface FundTransferResponse {
  success: boolean;
  message?: string;
  transaction_id?: string;
}

@Injectable()
export class BitcoinDeepaService {
  private readonly apiUrl: string;
  private readonly hmacSecret: string;
  private readonly timeout: number;
  private readonly endpoint = '/api/v1/send';

  constructor(private readonly dbLogger: DatabaseLoggerService) {
    this.apiUrl = process.env.BITCOINDEEPA_API_URL || '';
    this.hmacSecret = process.env.BITCOINDEEPA_HMAC_SECRET || '';
    this.timeout = parseInt(process.env.BITCOINDEEPA_TIMEOUT || '10000', 10);
  }

  /**
   * Generate HMAC signature for API authentication
   * Combines: METHOD + PATH + TIMESTAMP + BODY
   */
  private generateHmacSignature(
    httpMethod: string,
    urlPath: string,
    timestamp: string,
    body: string,
  ): string {
    const message = `${httpMethod}${urlPath}${timestamp}${body}`;
    return createHmac('sha256', this.hmacSecret).update(message).digest('hex');
  }

  /**
   * Transfer satoshis to user's wallet via BitcoinDeepa API
   */
  async transferFunds(
    amount: number,
    toTelegramId: string,
    memo: string,
  ): Promise<FundTransferResponse> {
    try {
      const url = `${this.apiUrl}${this.endpoint}`;
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const httpMethod = 'POST';

      const requestBody: FundTransferRequest = {
        amount,
        to: toTelegramId,
        memo,
      };

      const bodyString = JSON.stringify(requestBody);
      const signature = this.generateHmacSignature(
        httpMethod,
        this.endpoint,
        timestamp,
        bodyString,
      );

      const headers = {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Timestamp': timestamp,
      };

      await this.dbLogger.info(
        `BitcoinDeepaService.transferFunds: Attempting fund transfer of ${amount} satoshis to user ${toTelegramId} at ${this.endpoint}`
      );

      const response = await axios.post<FundTransferResponse>(
        url,
        requestBody,
        {
          headers,
          timeout: this.timeout,
        },
      );

      await this.dbLogger.info(
        `BitcoinDeepaService.transferFunds: Fund transfer successful - ${amount} satoshis to user ${toTelegramId}, status: ${response.status}`
      );

      return response.data;
    } catch (error: any) {
      await this.dbLogger.error(
        `BitcoinDeepaService.transferFunds: Fund transfer failed for ${amount} satoshis to user ${toTelegramId}: ${error.message}`
      );

      // Return a standardized error response
      return {
        success: false,
        message:
          error.response?.data?.message ||
          error.message ||
          'Fund transfer failed',
      };
    }
  }

  /**
   * Validate configuration on service initialization
   */
  isConfigured(): boolean {
    return !!(this.apiUrl && this.hmacSecret);
  }
}
