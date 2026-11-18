import { Injectable, Logger } from '@nestjs/common';
import axios, { Method } from 'axios';
import { createHash, createHmac, createPublicKey, verify } from 'crypto';

export interface CeyPayBank {
  code: number;
  name: string;
}

export interface CeyPayUser {
  userId: string;
  externalUserId: string;
}

export interface CeyPayBankAccount {
  userBankId: string;
  bankCode: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface CeyPayQuote {
  fxLockId: string;
  rateUsdtLkr: number;
  amountLkr: number;
  amountUsdt: number;
  expiresAt: string;
}

export type CeyPayOfframpStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export interface CeyPayOfframp {
  paymentId: string;
  status: CeyPayOfframpStatus;
  amountLkr: number;
  amountUsdt: number;
  rateUsdtLkr: number;
  externalRef: string;
  bankRef?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  failureReason?: string | null;
}

export interface CreateOfframpRequest {
  fxLockId: string;
  userId: string;
  userBankId: string;
  externalRef: string;
  webhookUrl?: string;
}

/**
 * A failed CeyPay call. `outcomeUnknown` means we got no answer (timeout,
 * network, 5xx): the request may have been applied, so only retry calls that
 * are idempotent on CeyPay's side.
 */
export class CeyPayError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = 'CeyPayError';
  }
}

const MAX_WEBHOOK_AGE_MS = 5 * 60_000;

/**
 * Client for CeyPay's aggregator (off-ramp partner) API.
 *
 * Auth: x-api-key (key id), x-timestamp (ms), x-signature =
 * hex HMAC-SHA256(key = sha256hex(secret), timestamp + METHOD + path + body).
 */
@Injectable()
export class CeyPayService {
  private readonly logger = new Logger(CeyPayService.name);
  private readonly apiUrl = (process.env.CEYPAY_API_URL || '').replace(
    /\/+$/,
    '',
  );
  private readonly keyId = process.env.CEYPAY_API_KEY_ID || '';
  private readonly secret = process.env.CEYPAY_API_SECRET || '';
  private readonly webhookPublicKey =
    process.env.CEYPAY_WEBHOOK_PUBLIC_KEY || '';
  private readonly timeout = parseInt(
    process.env.CEYPAY_TIMEOUT || '10000',
    10,
  );

  isConfigured(): boolean {
    return !!(this.apiUrl && this.keyId && this.secret);
  }

  getBanks(): Promise<CeyPayBank[]> {
    return this.request('GET', '/v1/bank/list');
  }

  /** Idempotent on externalUserId. */
  upsertUser(externalUserId: string): Promise<CeyPayUser> {
    return this.request('POST', '/v1/aggregator/user', { externalUserId });
  }

  addBankAccount(
    ceypayUserId: string,
    account: { bankCode: number; accountNumber: string; accountName: string },
  ): Promise<CeyPayBankAccount> {
    return this.request(
      'POST',
      `/v1/aggregator/user/${encodeURIComponent(ceypayUserId)}/bank-account`,
      account,
    );
  }

  listBankAccounts(ceypayUserId: string): Promise<CeyPayBankAccount[]> {
    return this.request(
      'GET',
      `/v1/aggregator/user/${encodeURIComponent(ceypayUserId)}/bank-account/list`,
    );
  }

  /** 60s rate lock. amountUsdt has at most 8 decimals. */
  getQuote(amountUsdt: string): Promise<CeyPayQuote> {
    return this.request(
      'GET',
      `/v1/aggregator/quote?amount_usdt=${encodeURIComponent(amountUsdt)}`,
    );
  }

  /** Idempotent on externalRef: the same ref returns the existing off-ramp. */
  createOfframp(body: CreateOfframpRequest): Promise<CeyPayOfframp> {
    return this.request('POST', '/v1/aggregator/offramp', body);
  }

  getOfframp(paymentId: string): Promise<CeyPayOfframp> {
    return this.request(
      'GET',
      `/v1/aggregator/offramp/${encodeURIComponent(paymentId)}`,
    );
  }

  /**
   * CeyPay webhooks: base64 ED25519 signature over `${timestamp}${body}`
   * (X-Webhook-Signature, X-Webhook-Timestamp in ms).
   */
  verifyWebhookSignature(
    rawBody: Buffer | string | undefined,
    timestamp: string | undefined,
    signature: string | undefined,
    now = Date.now(),
  ): boolean {
    if (!this.webhookPublicKey || !rawBody || !timestamp || !signature) {
      return false;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_WEBHOOK_AGE_MS) {
      return false;
    }
    try {
      const message = Buffer.concat([
        Buffer.from(timestamp),
        Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody),
      ]);
      return verify(
        null,
        message,
        CeyPayService.toPublicKey(this.webhookPublicKey),
        Buffer.from(signature, 'base64'),
      );
    } catch (error) {
      this.logger.warn(
        `CeyPay webhook signature check failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** Accepts a PEM, or a base64 SPKI DER (env vars are often single-line). */
  private static toPublicKey(key: string) {
    const pem = key.replace(/\\n/g, '\n').trim();
    if (pem.startsWith('-----BEGIN')) return createPublicKey(pem);
    return createPublicKey({
      key: Buffer.from(pem, 'base64'),
      format: 'der',
      type: 'spki',
    });
  }

  /** Headers for a signed request. Exposed for tests. */
  signHeaders(
    method: string,
    pathWithQuery: string,
    body: string,
    timestamp = Date.now().toString(),
  ): Record<string, string> {
    const signingKey = createHash('sha256').update(this.secret).digest('hex');
    const signature = createHmac('sha256', signingKey)
      .update(`${timestamp}${method.toUpperCase()}${pathWithQuery}${body}`)
      .digest('hex');
    return {
      'x-api-key': this.keyId,
      'x-timestamp': timestamp,
      'x-signature': signature,
    };
  }

  private async request<T>(
    method: Method,
    path: string,
    body?: object,
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new CeyPayError('CeyPay is not configured', undefined, false);
    }
    const url = `${this.apiUrl}${path}`;
    // CeyPay signs request.originalUrl, which includes any base path prefix
    const parsed = new URL(url);
    const bodyString =
      body && Object.keys(body).length > 0 ? JSON.stringify(body) : '';

    try {
      const response = await axios.request<T>({
        method,
        url,
        data: bodyString || undefined,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...this.signHeaders(
            String(method),
            `${parsed.pathname}${parsed.search}`,
            bodyString,
          ),
        },
        timeout: this.timeout,
      });
      return response.data;
    } catch (error) {
      throw CeyPayService.toError(error, `${String(method)} ${path}`);
    }
  }

  static toError(error: unknown, context: string): CeyPayError {
    if (error instanceof CeyPayError) return error;
    const err = error as {
      message?: string;
      response?: { status?: number; data?: { message?: unknown } };
    };
    const status = err.response?.status;
    const raw = err.response?.data?.message;
    const detail = Array.isArray(raw)
      ? raw.join(', ')
      : typeof raw === 'string'
        ? raw
        : err.message || 'request failed';
    // No response, or 5xx/429 from CeyPay or a proxy: may or may not have applied
    const outcomeUnknown =
      status === undefined || status >= 500 || status === 429;
    return new CeyPayError(
      `CeyPay ${context} failed: ${detail}${status ? ` (HTTP ${status})` : ''}`,
      status,
      outcomeUnknown,
    );
  }
}
