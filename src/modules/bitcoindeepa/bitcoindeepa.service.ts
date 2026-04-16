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
  already_completed?: boolean; // True if transfer was already completed in a previous attempt
}

export interface UserBalanceRequest {
  telegram_id: number;
}

export interface UserBalanceResponse {
  success: boolean;
  message?: string;
  telegram_id?: number;
  balance?: number; // balance in satoshis
  balance_lkr?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  created_at?: string;
}

@Injectable()
export class BitcoinDeepaService {
  private readonly apiUrl: string;
  private readonly hmacSecret: string;
  private readonly timeout: number;
  private readonly sendEndpoint = '/api/v1/send';
  private readonly balanceEndpoint = '/api/v1/userbalance';

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
      const url = `${this.apiUrl}${this.sendEndpoint}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const httpMethod = 'POST';

      const requestBody: FundTransferRequest = {
        amount: Number(amount),
        to: toTelegramId,
        memo,
      };

      const bodyString = JSON.stringify(requestBody);
      const signature = this.generateHmacSignature(
        httpMethod,
        this.sendEndpoint,
        timestamp.toString(),
        bodyString,
      );

      const headers = {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Timestamp': timestamp.toString(),
      };

      await this.dbLogger.info(
        `BitcoinDeepaService.transferFunds: Attempting fund transfer of ${amount} satoshis to user ${toTelegramId} at ${this.sendEndpoint}`,
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
        `BitcoinDeepaService.transferFunds: Fund transfer successful - ${amount} satoshis to user ${toTelegramId}, status: ${response.status}`,
      );

      return response.data;
    } catch (error: any) {
      // Extract error message from response (BitcoinDeepa uses 'error' field, not 'message')
      const errorMessage =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        'Fund transfer failed';

      // Log full error details for debugging
      await this.dbLogger.error(
        `BitcoinDeepaService.transferFunds: Fund transfer failed for ${amount} satoshis to user ${toTelegramId}: ${errorMessage} (status: ${error.response?.status})`,
      );

      // Check if this is an "already completed" error (transfer actually succeeded)
      const isAlreadyCompleted =
        errorMessage.toLowerCase().includes('already completed') ||
        errorMessage.toLowerCase().includes('already exists');

      // Return a standardized error response
      return {
        success: false,
        message: errorMessage,
        already_completed: isAlreadyCompleted,
      };
    }
  }

  /**
   * Validate configuration on service initialization
   */
  async getUserBalance(telegramId: number): Promise<UserBalanceResponse> {
    try {
      const url = `${this.apiUrl}${this.balanceEndpoint}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const httpMethod = 'POST';

      const requestBody: UserBalanceRequest = {
        telegram_id: telegramId,
      };

      const bodyString = JSON.stringify(requestBody);
      const signature = this.generateHmacSignature(
        httpMethod,
        this.balanceEndpoint,
        timestamp.toString(),
        bodyString,
      );

      const headers = {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Timestamp': timestamp.toString(),
      };

      await this.dbLogger.info(
        `BitcoinDeepaService.getUserBalance: Fetching balance for user ${telegramId} at ${this.balanceEndpoint}`,
      );

      const response = await axios.post<UserBalanceResponse>(url, requestBody, {
        headers,
        timeout: this.timeout,
      });

      await this.dbLogger.info(
        `BitcoinDeepaService.getUserBalance: Balance fetch successful for user ${telegramId}, status: ${response.status}`,
      );

      return response.data;
    } catch (error: any) {
      await this.dbLogger.error(
        `BitcoinDeepaService.getUserBalance: Balance fetch failed for user ${telegramId}: ${error.message}`,
      );

      return {
        success: false,
        message:
          error.response?.data?.message ||
          error.message ||
          'Balance fetch failed',
      };
    }
  }

  isConfigured(): boolean {
    return !!(this.apiUrl && this.hmacSecret);
  }
}
