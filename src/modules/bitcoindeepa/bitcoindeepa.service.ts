import { Injectable, Logger } from '@nestjs/common';
import type { KeyObject } from 'crypto';
import axios, { AxiosResponse, Method } from 'axios';
import {
  loadEd25519Key,
  SEND_SIGNING_VERSION,
  sha256hex,
  signBotRequest,
} from './bot-signer';

/**
 * Why a send didn't go through. Settlement uses it to decide what to do next:
 * - LOW_BALANCE: the DCA wallet lacked funds (retried when the bot reports a deposit)
 * - REJECTED: the bot refused it, nothing was sent (bad recipient, limits, ...)
 * - AUTH: signing, timestamp, nonce or IP problem (401/403) - a config issue
 * - UNKNOWN: no answer or a 5xx - it may have gone through; retry with the SAME memo
 */
export type TransferFailure = 'LOW_BALANCE' | 'REJECTED' | 'AUTH' | 'UNKNOWN';

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
  failure?: TransferFailure;
  /** 202: above the bot's approval threshold, waiting for a human in Telegram. Poll getSendStatus(). */
  awaiting_approval_id?: string;
}

/** A collect request: we ask a user to pay the DCA wallet (sell flow). */
export type CollectRequestStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'expired';

export interface CollectRequest {
  id: string;
  status: CollectRequestStatus;
  /** true once the approved payment completed */
  paid: boolean;
  amount: number;
  external_id?: string;
  /** false: the bot couldn't message the user (blocked it); the app can still pay */
  notified?: boolean;
  expires_at?: string;
  /** Set once approved: the user's P2P payment to us */
  transfer?: {
    id: string;
    status: string;
    error?: string;
    confirm_by?: string;
  };
}

/**
 * - ok: the bot's answer
 * - unknown: no answer, a 5xx, 429 or 409 in_progress. Safe to ask again:
 *   create is idempotent on external_id, the others don't move anything
 * - refused: a definite 4xx ({code, message} from the bot)
 */
export type CollectResult =
  | { kind: 'ok'; request: CollectRequest }
  | { kind: 'unknown'; message: string }
  | { kind: 'refused'; status: number; code: string; message: string };

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

/** GET /api/v1/send/status/{id}: an approval-gated send */
export type SendApprovalStatus =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'in_flight';

export interface SendStatusResponse {
  id?: string;
  status: SendApprovalStatus;
  amount?: number;
  memo?: string;
  payment_hash?: string;
}

// The bot's 400 message for a sending wallet without enough sats
const LOW_BALANCE_PATTERN =
  /insufficient|low balance|not enough|balance too low/i;
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_HISTORY_PAGE = 250; // the bot's max `limit` for /usertransactions
const MEMO_LOOKUP_PAGES = 4;

@Injectable()
export class BitcoinDeepaService {
  private readonly logger = new Logger(BitcoinDeepaService.name);

  private readonly apiUrl: string;
  private readonly walletId: string;
  private readonly privateKey: KeyObject | null;
  private readonly timeout: number;
  /** An invoice payment can wait up to 60s before /send answers (doc: >= 95s) */
  private readonly sendTimeout: number;
  private readonly sendEndpoint = '/api/v1/send';
  private readonly sendStatusEndpoint = '/api/v1/send/status';
  private readonly collectEndpoint = '/api/v1/collect';
  private readonly balanceEndpoint = '/api/v1/userbalance';
  private readonly userTransactionsEndpoint = '/api/v1/usertransactions';

  constructor() {
    this.apiUrl = process.env.BITCOINDEEPA_API_URL || '';
    this.walletId = process.env.BITCOINDEEPA_WALLET_ID || '';
    this.privateKey = loadEd25519Key(
      process.env.BITCOINDEEPA_SEND_PRIVATE_KEY_PEM,
      'BITCOINDEEPA_SEND_PRIVATE_KEY_PEM',
      this.logger,
    );
    this.timeout = parseInt(process.env.BITCOINDEEPA_TIMEOUT || '10000', 10);
    this.sendTimeout = parseInt(
      process.env.BITCOINDEEPA_SEND_TIMEOUT || '95000',
      10,
    );
    if (BitcoinDeepaService.isCollectMocked()) {
      this.logger.warn(
        'BITCOINDEEPA_COLLECT_MOCK is on: sell debits are NOT sent to the bot (sandbox only)',
      );
    }
  }

  /**
   * Dev without a collect-enabled wallet on the bot can pretend every sell
   * debit was approved and paid. Env validation only allows it with the
   * CeyPay sandbox.
   */
  static isCollectMocked(): boolean {
    return process.env.BITCOINDEEPA_COLLECT_MOCK === 'true';
  }

  isConfigured(): boolean {
    return !!(this.apiUrl && this.walletId && this.privateKey);
  }

  /**
   * A request to the bot, signed with Ed25519 over
   *   BDB-SEND-ED25519-V1 \n METHOD \n PATH \n QUERY \n TIMESTAMP \n NONCE \n sha256hex(body)
   * The body is serialized once and those exact bytes are hashed and sent.
   * Every call (retries included) gets a fresh timestamp and nonce: the bot
   * rejects a reused nonce.
   */
  private signedRequest<T>(
    method: Extract<Method, 'GET' | 'POST'>,
    pathWithQuery: string,
    body?: object,
    timeoutMs = this.timeout,
  ): Promise<AxiosResponse<T>> {
    if (!this.privateKey) {
      return Promise.reject(new Error('BitcoinDeepa API is not configured'));
    }
    const raw = body ? JSON.stringify(body) : '';
    const signed = signBotRequest({
      version: SEND_SIGNING_VERSION,
      method,
      pathWithQuery,
      hashedLines: [sha256hex(raw)],
      key: this.privateKey,
    });

    return axios.request<T>({
      method,
      url: `${this.apiUrl}${pathWithQuery}`,
      data: body ? raw : undefined,
      // Keep axios from re-serializing: the signed bytes must be the sent bytes
      transformRequest: [(data: unknown) => data],
      headers: {
        'Content-Type': 'application/json',
        'X-Wallet-ID': this.walletId,
        ...signed,
      },
      timeout: timeoutMs,
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
   * What a refused send means. Auth (401/403) is checked first: its message
   * must never be read as a duplicate memo. "Already completed" (the memo is
   * the bot's idempotency key) only counts on a plain rejection (400/409).
   */
  private static classifyRejection(
    httpStatus: number,
    message: string,
  ): FundTransferResponse {
    if (httpStatus === 401 || httpStatus === 403) {
      return { success: false, message, failure: 'AUTH' };
    }
    const lower = String(message).toLowerCase();
    const duplicateMemo =
      (httpStatus === 400 || httpStatus === 409 || httpStatus === 200) &&
      (lower.includes('already completed') || lower.includes('already exists'));
    if (duplicateMemo) {
      return { success: false, message, already_completed: true };
    }
    return {
      success: false,
      message,
      failure: LOW_BALANCE_PATTERN.test(message) ? 'LOW_BALANCE' : 'REJECTED',
    };
  }

  /**
   * Turn a failed send/collect into a result:
   * - no HTTP response (timeout, connection reset) or a 5xx: it may still have
   *   gone through (outcome_unknown). Resending with the SAME memo is safe: a
   *   memo that already completed comes back as "already completed".
   * - otherwise the bot refused it (see classifyRejection)
   */
  private static toFailedTransfer(
    error: unknown,
    message: string,
  ): FundTransferResponse {
    const httpStatus = (error as { response?: { status?: number } })?.response
      ?.status;
    if (httpStatus === undefined || Number(httpStatus) >= 500) {
      return {
        success: false,
        message,
        outcome_unknown: true,
        failure: 'UNKNOWN',
      };
    }
    return BitcoinDeepaService.classifyRejection(Number(httpStatus), message);
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
      const response = await this.signedRequest<
        FundTransferResponse & {
          status?: string;
          payment_hash?: string;
          id?: string;
        }
      >('POST', this.sendEndpoint, requestBody, this.sendTimeout);
      const data = response.data ?? { success: false };

      if (response.status === 202) {
        if (data.status === 'awaiting_approval') {
          const id = BitcoinDeepaService.approvalId(data);
          if (id) {
            this.logger.warn(
              `BitcoinDeepa transfer of ${amount} sats to user ${toTelegramId} is awaiting approval (bot transaction ${id})`,
            );
            return {
              success: false,
              message: data.message,
              awaiting_approval_id: id,
            };
          }
        }
        // 202 "pending" is an invoice still routing - we never send invoices,
        // so anything else accepted-but-not-done is an unknown outcome
        this.logger.error(
          `BitcoinDeepa transfer of ${amount} sats to user ${toTelegramId} returned 202 ${data.status ?? ''}: ${data.message ?? ''}`,
        );
        return {
          success: false,
          message:
            data.message ?? `Accepted but not completed (${data.status})`,
          outcome_unknown: true,
          failure: 'UNKNOWN',
        };
      }

      if (!data.success) {
        return BitcoinDeepaService.classifyRejection(
          response.status,
          data.message ?? 'Fund transfer failed',
        );
      }
      this.logger.log(
        `BitcoinDeepa transfer OK: ${amount} sats to user ${toTelegramId} (status ${response.status})`,
      );
      return data;
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
   * The approval id of a 202: a structured field if the bot sends one,
   * otherwise the id after "Transaction ID: " in the message (the documented
   * way). Only the id's own characters, so trailing punctuation isn't taken.
   */
  private static approvalId(data: {
    id?: string;
    transaction_id?: string;
    message?: string;
  }): string | undefined {
    const structured = data.transaction_id ?? data.id;
    if (structured && APPROVAL_ID_PATTERN.test(structured)) return structured;
    return /Transaction ID:\s*([A-Za-z0-9_-]+)/i.exec(data.message ?? '')?.[1];
  }

  /**
   * Status of a send that was held for approval. 'NOT_FOUND' when the bot
   * doesn't know the id (404); null when it can't be read now (network, 5xx).
   */
  async getSendStatus(
    transactionId: string,
  ): Promise<SendStatusResponse | 'NOT_FOUND' | null> {
    try {
      const response = await this.signedRequest<SendStatusResponse>(
        'GET',
        `${this.sendStatusEndpoint}/${encodeURIComponent(transactionId)}`,
      );
      return response.data?.status ? response.data : null;
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return 'NOT_FOUND';
      }
      this.logger.error(
        `BitcoinDeepa send status for ${transactionId} failed: ${BitcoinDeepaService.errorMessage(error, 'Status fetch failed')} (status: ${error.response?.status})`,
      );
      return null;
    }
  }

  /**
   * Whether the user received a successful transfer with this memo (checks
   * the latest MEMO_LOOKUP_PAGES pages of their bot history). Null when the
   * history can't be read - the caller must not assume either way.
   */
  async findTransferByMemo(
    telegramId: number,
    memo: string,
  ): Promise<boolean | null> {
    for (let page = 0; page < MEMO_LOOKUP_PAGES; page++) {
      const history = await this.getUserTransactions(
        telegramId,
        MAX_HISTORY_PAGE,
        page * MAX_HISTORY_PAGE,
      );
      if (!history.success) return null;
      const found = history.transactions.some(
        (tx) => tx.memo === memo && tx.direction === 'incoming' && tx.success,
      );
      if (found) return true;
      if (history.transactions.length < MAX_HISTORY_PAGE) return false;
    }
    return false;
  }

  /**
   * Ask a user to pay the DCA wallet (POST /api/v1/collect). Nothing moves
   * until they approve, in the bot chat or in the app. external_id makes it
   * idempotent: asking again returns the same request (200 instead of 201).
   */
  createCollect(
    toTelegramId: string,
    amount: number,
    memo: string,
    externalId: string,
  ): Promise<CollectResult> {
    return this.collectCall('POST', this.collectEndpoint, {
      to: toTelegramId,
      amount: Number(amount),
      memo,
      external_id: externalId,
    });
  }

  getCollect(id: string): Promise<CollectResult> {
    return this.collectCall(
      'GET',
      `${this.collectEndpoint}/${encodeURIComponent(id)}`,
    );
  }

  /** Withdraw a pending request. 409 request_closed: it was answered first. */
  cancelCollect(id: string): Promise<CollectResult> {
    return this.collectCall(
      'POST',
      `${this.collectEndpoint}/${encodeURIComponent(id)}/cancel`,
      {},
    );
  }

  private async collectCall(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ): Promise<CollectResult> {
    try {
      const response = await this.signedRequest<CollectRequest>(
        method,
        path,
        body,
      );
      return { kind: 'ok', request: response.data };
    } catch (error: unknown) {
      const response = (
        error as {
          response?: {
            status?: number;
            data?: { code?: unknown; message?: unknown };
          };
        }
      )?.response;
      const status = response?.status;
      const data = response?.data;
      const code = typeof data?.code === 'string' ? data.code : '';
      const message = BitcoinDeepaService.errorMessage(error, 'Collect failed');
      const unknown =
        status === undefined ||
        status >= 500 ||
        status === 429 ||
        (status === 409 && code === 'in_progress');
      this.logger[unknown ? 'warn' : 'error'](
        `BitcoinDeepa ${method} ${path}: ${status ?? 'no answer'} ${code} ${message}`,
      );
      if (unknown) return { kind: 'unknown', message };
      if (status === 401 || (status === 403 && !code)) {
        // Our key, wallet id, clock or IP (a plain-text 403 is the allowlist)
        return { kind: 'refused', status, code: 'auth', message };
      }
      return { kind: 'refused', status, code, message };
    }
  }

  async getUserBalance(telegramId: number): Promise<UserBalanceResponse> {
    const requestBody: UserBalanceRequest = { telegram_id: telegramId };
    // No secrets here: the signature, timestamp and nonce are added per call
    this.logger.log(
      `BitcoinDeepa balance request: POST ${this.apiUrl}${this.balanceEndpoint} wallet=${this.walletId} body=${JSON.stringify(requestBody)}`,
    );
    try {
      const response = await this.signedRequest<UserBalanceResponse>(
        'POST',
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
      const response = await this.signedRequest<UserTransactionsResponse>(
        'POST',
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
