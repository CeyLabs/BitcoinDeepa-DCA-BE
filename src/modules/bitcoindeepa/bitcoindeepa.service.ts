import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import axios, { AxiosResponse } from 'axios';

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

/** Debit a user's wallet into the platform wallet (sell flow). */
export interface FundCollectRequest {
  telegram_id: number;
  amount: number; // satoshis
  memo: string; // unique per sell order; the API rejects a duplicate memo
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

const GATEWAY_ERROR_STATUSES = [502, 503, 504];

@Injectable()
export class BitcoinDeepaService {
  private readonly logger = new Logger(BitcoinDeepaService.name);

  private readonly apiUrl: string;
  private readonly hmacSecret: string;
  private readonly timeout: number;
  private readonly sendEndpoint = '/api/v1/send';
  private readonly collectEndpoint = '/api/v1/collect';
  private readonly balanceEndpoint = '/api/v1/userbalance';
  private readonly userTransactionsEndpoint = '/api/v1/usertransactions';

  constructor() {
    this.apiUrl = process.env.BITCOINDEEPA_API_URL || '';
    this.hmacSecret = process.env.BITCOINDEEPA_HMAC_SECRET || '';
    this.timeout = parseInt(process.env.BITCOINDEEPA_TIMEOUT || '10000', 10);
    if (BitcoinDeepaService.isCollectMocked()) {
      this.logger.warn(
        'BITCOINDEEPA_COLLECT_MOCK is on: sell debits are NOT sent to the bot (sandbox only)',
      );
    }
  }

  /**
   * Until the bot's collect endpoint exists, dev can pretend every debit
   * succeeded. Env validation only allows it with the CeyPay sandbox.
   */
  static isCollectMocked(): boolean {
    return process.env.BITCOINDEEPA_COLLECT_MOCK === 'true';
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
   * Turn a failed send/collect into a result:
   * - no HTTP response (timeout, connection reset), or a gateway error from a
   *   proxy in front of the API (502/503/504): it may still have gone
   *   through, so it must not be blindly retried (outcome_unknown)
   * - the API reports a duplicate memo/ref as an error: treat it as done
   */
  private static toFailedTransfer(
    error: unknown,
    message: string,
  ): FundTransferResponse {
    const httpStatus = (error as { response?: { status?: number } })?.response
      ?.status;
    if (
      httpStatus === undefined ||
      GATEWAY_ERROR_STATUSES.includes(Number(httpStatus))
    ) {
      return { success: false, message, outcome_unknown: true };
    }
    const lower = String(message).toLowerCase();
    return {
      success: false,
      message,
      already_completed:
        lower.includes('already completed') || lower.includes('already exists'),
    };
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
      this.logger.log(
        `BitcoinDeepa transfer OK: ${amount} sats to user ${toTelegramId} (status ${response.status})`,
      );
      return response.data;
    } catch (error: any) {
      const message = BitcoinDeepaService.errorMessage(
        error,
        'Fund transfer failed',
      );
      this.logger.error(
        `BitcoinDeepa transfer failed: ${amount} sats to user ${toTelegramId}: ${message} (status: ${error.response?.status})`,
      );
      return BitcoinDeepaService.toFailedTransfer(error, message);
    }
  }

  /**
   * Debit satoshis from a user's wallet into the platform wallet (sell flow).
   * Same result semantics as transferFunds, except that any 5xx is an unknown
   * outcome: the debit may have happened before the error, and the endpoint's
   * contract doesn't promise otherwise yet.
   */
  async collectFunds(
    amount: number,
    fromTelegramId: string,
    memo: string,
  ): Promise<FundTransferResponse> {
    if (BitcoinDeepaService.isCollectMocked()) {
      this.logger.warn(
        `MOCK collect: ${amount} sats from user ${fromTelegramId} (${memo}) treated as debited`,
      );
      return { success: true, message: 'Mock collect (not sent to the bot)' };
    }
    const requestBody: FundCollectRequest = {
      telegram_id: Number(fromTelegramId),
      amount: Number(amount),
      memo,
    };

    try {
      const response = await this.signedPost<FundTransferResponse>(
        this.collectEndpoint,
        requestBody,
      );
      this.logger.log(
        `BitcoinDeepa collect OK: ${amount} sats from user ${fromTelegramId} (status ${response.status})`,
      );
      return response.data;
    } catch (error: any) {
      const message = BitcoinDeepaService.errorMessage(
        error,
        'Fund collect failed',
      );
      this.logger.error(
        `BitcoinDeepa collect failed: ${amount} sats from user ${fromTelegramId}: ${message} (status: ${error.response?.status})`,
      );
      if (Number(error.response?.status) >= 500) {
        return { success: false, message, outcome_unknown: true };
      }
      return BitcoinDeepaService.toFailedTransfer(error, message);
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
      this.logger.error(
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
      this.logger.error(
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
