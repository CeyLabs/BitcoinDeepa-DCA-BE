import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import axios from 'axios';
import { errorMessage } from '../../common/error-message';

export interface IGetLinkParams {
  user_id: string;
  /** Recurring checkouts only; informational (custom_2) */
  package_id?: string;
  order_id: string;
  amount: string;
  currency: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  items: string;
  /** Both set = a recurring (subscription) checkout; both unset = one-off */
  recurrence?: '1 Month' | '1 Week';
  duration?: 'Forever';
  type: string;
  /**
   * Added to return_url/cancel_url so the app knows which checkout the payer
   * came back from (PayHere appends nothing). UX only: never trusted.
   */
  return_query?: Record<string, string>;
}

interface CancelSubscriptionResponse {
  status: 1 | -1;
  msg: string;
}

export interface SubscriptionPayment {
  payment_id: string;
  /** e.g. RECEIVED for a successful charge */
  status: string;
  /** Amount PayHere charged, as it returns it (e.g. "1000.00"); null if absent */
  amount: string | null;
  /** The subscription's checkout order_id (the same on every charge) */
  order_id: string | null;
}

/** A payment as PayHere's Retrieval API lists it */
export type OrderPayment = SubscriptionPayment;

// Every PayHere API call is bounded: settlement handles payments one after
// another, so a hung request would stall every payout behind it.
const PAYHERE_API_TIMEOUT_MS = 10000;
// Refresh the OAuth token this long before PayHere says it expires
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** `url` with `query` added; `url` unchanged when it isn't a valid URL. */
function withQuery(url: string, query?: Record<string, string>): string {
  if (!query) return url;
  try {
    const u = new URL(url);
    for (const [key, value] of Object.entries(query)) {
      u.searchParams.set(key, value);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function md5String(input: string): string {
  try {
    return createHash('md5').update(input).digest('hex');
  } catch {
    return '';
  }
}

@Injectable()
export class PayHereService {
  private readonly logger = new Logger(PayHereService.name);
  private cachedToken: { token: string; expiresAt: number } | null = null;

  getBaseUrl(): string {
    return (process.env.PAYHERE_ENV as string) === 'live'
      ? 'https://www.payhere.lk'
      : 'https://sandbox.payhere.lk';
  }

  getLink({
    user_id,
    package_id,
    order_id,
    amount,
    currency,
    first_name,
    last_name,
    email,
    phone,
    address,
    city,
    country,
    items,
    recurrence,
    duration,
    type = 'checkout',
    return_query,
  }: IGetLinkParams): string {
    this.logger.log(
      `Generating PayHere ${recurrence ? 'recurring' : 'one-off'} payment link for order: ${order_id}, amount: ${amount} ${currency}, user: ${user_id}${package_id ? `, package: ${package_id}` : ''}`,
    );
    const hashedSecret = md5String(
      String(process.env.PAYHERE_MERCHANT_SECRET),
    ).toUpperCase();

    const amountFormatted = parseFloat(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      useGrouping: false,
    });
    const hash = md5String(
      String(process.env.PAYHERE_MERCHANT_ID) +
        order_id +
        amountFormatted +
        currency +
        hashedSecret,
    ).toUpperCase();

    const params: Record<string, string> = {
      merchant_id: String(process.env.PAYHERE_MERCHANT_ID),
      return_url: withQuery(
        String(process.env.PAYHERE_RETURN_URL),
        return_query,
      ),
      cancel_url: withQuery(
        String(process.env.PAYHERE_CANCEL_URL),
        return_query,
      ),
      notify_url: String(process.env.PAYHERE_NOTIFY_URL),
      first_name,
      last_name,
      email,
      phone,
      address,
      city,
      country,
      order_id,
      items,
      currency,
      amount: amountFormatted,
      hash,
      // Informational only (shown in the PayHere dashboard). The webhook never
      // trusts these - they aren't covered by the hash and can be edited.
      custom_1: user_id,
    };
    // Not covered by the hash either, so a one-off checkout just leaves them
    // out. (A payer adding them would create a subscription whose order is
    // ONE_TIME - the webhook refuses that.)
    if (recurrence && duration) {
      params.recurrence = recurrence;
      params.duration = duration;
    }
    if (package_id) params.custom_2 = package_id;

    const link = `${this.getBaseUrl()}/pay/${type}?${new URLSearchParams(params).toString()}`;
    this.logger.log(
      `PayHere payment link generated successfully for order: ${order_id}`,
    );
    return link;
  }

  /** OAuth token, reused until shortly before it expires. */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }
    this.logger.log('Requesting PayHere OAuth token');

    const appId = process.env.PAYHERE_APP_ID;
    const appSecret = process.env.PAYHERE_APP_SECRET;
    if (!appId || !appSecret) {
      this.logger.error(
        'PayHere App ID/Secret not configured - OAuth token generation failed',
      );
      throw new Error('PayHere App ID/Secret not set');
    }

    try {
      const authCode = Buffer.from(`${appId}:${appSecret}`).toString('base64');
      const url = `${this.getBaseUrl()}/merchant/v1/oauth/token`;

      const params = new URLSearchParams();
      params.append('grant_type', 'client_credentials');
      const response: {
        data: {
          access_token: string;
          token_type: string;
          expires_in: number;
          scope: string;
        };
      } = await axios.post(url, params, {
        headers: {
          Authorization: `Basic ${authCode}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: PAYHERE_API_TIMEOUT_MS,
      });

      this.logger.log(
        `PayHere OAuth token generated successfully (expires in ${response.data.expires_in}s)`,
      );
      this.cachedToken = {
        token: response.data.access_token,
        expiresAt:
          Date.now() +
          Number(response.data.expires_in || 0) * 1000 -
          TOKEN_EXPIRY_MARGIN_MS,
      };
      return response.data.access_token;
    } catch (error) {
      this.logger.error(
        `PayHere OAuth token generation failed: ${errorMessage(error)}`,
      );
      throw error;
    }
  }

  async cancelSubscription(
    payhere_sub_id: string,
  ): Promise<CancelSubscriptionResponse> {
    this.logger.log(
      `Requesting PayHere subscription cancellation for: ${payhere_sub_id}`,
    );

    try {
      const accessToken = await this.getAccessToken();
      const url = `${this.getBaseUrl()}/merchant/v1/subscription/cancel`;

      const response: { data: CancelSubscriptionResponse } = await axios.post(
        url,
        { subscription_id: payhere_sub_id },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: PAYHERE_API_TIMEOUT_MS,
        },
      );

      this.logger.log(
        `PayHere subscription cancellation response for ${payhere_sub_id}: status=${response.data.status}, message=${response.data.msg}`,
      );
      return response.data;
    } catch (error) {
      this.forgetTokenIfRejected(error);
      this.logger.error(
        `PayHere subscription cancellation failed for ${payhere_sub_id}: ${errorMessage(error)}`,
      );
      throw error;
    }
  }

  /** A cached token PayHere rejects (e.g. revoked) must not be reused. */
  private forgetTokenIfRejected(error: unknown): void {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      this.cachedToken = null;
    }
  }

  /**
   * Payments PayHere actually took for a subscription (Subscription Manager
   * API). Used to confirm a notification's payment_id before paying out: the
   * md5sig doesn't cover payment_id, and a payer can point notify_url at
   * their own server to obtain a genuinely signed notification to replay.
   * https://support.payhere.lk/api-&-mobile-sdk/subscription-manager-api
   */
  async getSubscriptionPayments(
    payhere_sub_id: string,
  ): Promise<SubscriptionPayment[]> {
    const accessToken = await this.getAccessToken();
    const url = `${this.getBaseUrl()}/merchant/v1/subscription/${encodeURIComponent(payhere_sub_id)}/payments`;
    const response: {
      data: {
        status: number;
        msg: string;
        data?: {
          payment_id: number | string;
          status: string;
          amount?: number | string;
          order_id?: string;
        }[];
      };
    } = await axios
      .get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: PAYHERE_API_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        this.forgetTokenIfRejected(error);
        throw error;
      });

    // PayHere reports its own errors as HTTP 200 with status -1. Reading that
    // as "no payments" would make real payments look forged.
    if (response.data.status !== 1) {
      throw new Error(
        `PayHere payment lookup for subscription ${payhere_sub_id} failed: ${response.data.msg}`,
      );
    }

    return (response.data.data ?? []).map((p) => ({
      payment_id: String(p.payment_id),
      status: p.status,
      amount:
        p.amount === undefined || p.amount === null ? null : String(p.amount),
      order_id: p.order_id ?? null,
    }));
  }

  /**
   * Payments PayHere took for a checkout order_id (Retrieval API). The
   * one-off counterpart of getSubscriptionPayments, used the same way: only a
   * payment_id listed here as RECEIVED is paid out.
   * https://support.payhere.lk/api-&-mobile-sdk/retrieval-api
   */
  async getPaymentsByOrderId(order_id: string): Promise<OrderPayment[]> {
    const accessToken = await this.getAccessToken();
    const url = `${this.getBaseUrl()}/merchant/v1/payment/search`;
    const response: {
      data: {
        status: number;
        msg: string;
        data?:
          | {
              payment_id: number | string;
              order_id?: string;
              status: string;
              amount?: number | string;
            }[]
          | null;
      };
    } = await axios
      .get(url, {
        params: { order_id },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: PAYHERE_API_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        this.forgetTokenIfRejected(error);
        throw error;
      });

    // -1 "No payments found" is a real answer (not paid yet, or forged).
    // -1 is also used for errors (e.g. "Access denied for the domain"), and
    // reading those as "no payments" would make real payments look forged -
    // so only that exact message counts as empty.
    if (
      response.data.status === -1 &&
      /no payments found/i.test(response.data.msg ?? '')
    ) {
      return [];
    }
    if (response.data.status !== 1) {
      throw new Error(
        `PayHere payment lookup for order ${order_id} failed: ${response.data.msg}`,
      );
    }

    return (response.data.data ?? []).map((p) => ({
      payment_id: String(p.payment_id),
      status: p.status,
      amount:
        p.amount === undefined || p.amount === null ? null : String(p.amount),
      order_id: p.order_id ?? null,
    }));
  }
}
