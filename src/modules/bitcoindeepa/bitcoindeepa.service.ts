import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import axios, { AxiosResponse } from 'axios';
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
  outcome_unknown?: boolean; // True if we got no response (timeout/network) - the transfer may have happened
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

export interface UserTransactionsRequest {
  telegram_id: number;
  limit: number;
  offset: number;
}

export interface BotTransaction {
  id: number;
  time: string;
  direction: 'incoming' | 'outgoing';
  from_id: number;
  to_id: number;
  from_user?: string;
  to_user?: string;
  type: string;
  amount: number;
  amount_lkr: string;
  memo?: string;
  success: boolean;
}

export interface UserTransactionsResponse {
  success: boolean;
  telegram_id: number;
  count: number;
  limit: number;
  offset: number;
  transactions: BotTransaction[];
  message?: string;
}

@Injectable()
export class BitcoinDeepaService {
  private readonly apiUrl: string;
  private readonly hmacSecret: string;
  private readonly timeout: number;
  private readonly sendEndpoint = '/api/v1/send';
  private readonly balanceEndpoint = '/api/v1/userbalance';
  private readonly userTransactionsEndpoint = '/api/v1/usertransactions';

  constructor(private readonly dbLogger: DatabaseLoggerService) {
    this.apiUrl = process.env.BITCOINDEEPA_API_URL || '';
    this.hmacSecret = process.env.BITCOINDEEPA_HMAC_SECRET || '';
    this.timeout = parseInt(process.env.BITCOINDEEPA_TIMEOUT || '10000', 10);
  }

  isConfigured(): boolean {
    return !!(this.apiUrl && this.hmacSecret);
  }

  /**
   * POST to the BitcoinDeepa API, signed with
   * HMAC-SHA256(secret, METHOD + PATH + TIMESTAMP + BODY).
   */
  private signedPost<T>(path: string, body: object): Promise<AxiosResponse<T>> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyString = JSON.stringify(body);
    const signature = createHmac('sha256', this.hmacSecret)
      .update(`POST${path}${timestamp}${bodyString}`)
      .digest('hex');

    return axios.post<T>(`${this.apiUrl}${path}`, bodyString, {
      headers: {
        'Content-Type': 'application/json',
        'X-HMAC-Signature': signature,
        'X-Timestamp': timestamp,
      },
      timeout: this.timeout,
    });
  }

  private static errorMessage(error: any, fallback: string): string {
    return String(
      error?.response?.data?.error ||
        error?.response?.data?.message ||
        error?.message ||
        fallback,
    );
  }

  /**
   * Transfer satoshis to user's wallet via BitcoinDeepa API
   */
  async transferFunds(
    amount: number,
    toTelegramId: string,
    memo: string,
  ): Promise<FundTransferResponse> {
    const requestBody: FundTransferRequest = {
      amount: Number(amount),
      to: toTelegramId,
      memo,
    };

    try {
      const response = await this.signedPost<FundTransferResponse>(
        this.sendEndpoint,
        requestBody,
      );
      await this.dbLogger.info(
        `BitcoinDeepa transfer OK: ${amount} sats to user ${toTelegramId} (status ${response.status})`,
      );
      return response.data;
    } catch (error: any) {
      const message = BitcoinDeepaService.errorMessage(
        error,
        'Fund transfer failed',
      );
      await this.dbLogger.error(
        `BitcoinDeepa transfer failed: ${amount} sats to user ${toTelegramId}: ${message} (status: ${error.response?.status})`,
      );

      // No HTTP response (timeout, connection reset): the server may still
      // have processed the transfer, so this must not be blindly retried.
      if (!error.response) {
        return { success: false, message, outcome_unknown: true };
      }

      // The API reports a duplicate memo/ref as an error; treat it as done.
      const lower = String(message).toLowerCase();
      return {
        success: false,
        message,
        already_completed:
          lower.includes('already completed') ||
          lower.includes('already exists'),
      };
    }
  }

  async getUserBalance(telegramId: number): Promise<UserBalanceResponse> {
    const requestBody: UserBalanceRequest = { telegram_id: telegramId };
    try {
      const response = await this.signedPost<UserBalanceResponse>(
        this.balanceEndpoint,
        requestBody,
      );
      return response.data;
    } catch (error: any) {
      const message = BitcoinDeepaService.errorMessage(
        error,
        'Balance fetch failed',
      );
      await this.dbLogger.error(
        `BitcoinDeepa balance fetch failed for user ${telegramId}: ${message}`,
      );
      return { success: false, message };
    }
  }

  /**
   * Fetch a user's bot transaction (sats send/receive) history via BitcoinDeepa API
   */
  async getUserTransactions(
    telegramId: number,
    limit = 100,
    offset = 0,
  ): Promise<UserTransactionsResponse> {
    const requestBody: UserTransactionsRequest = {
      telegram_id: telegramId,
      limit,
      offset,
    };
    try {
      const response = await this.signedPost<UserTransactionsResponse>(
        this.userTransactionsEndpoint,
        requestBody,
      );
      return response.data;
    } catch (error: any) {
      const message = BitcoinDeepaService.errorMessage(
        error,
        'Fetching transactions failed',
      );
      await this.dbLogger.error(
        `BitcoinDeepa transactions fetch failed for user ${telegramId}: ${message} (status: ${error.response?.status})`,
      );
      return {
        success: false,
        telegram_id: telegramId,
        count: 0,
        limit,
        offset,
        transactions: [],
        message,
      };
    }
  }
}
