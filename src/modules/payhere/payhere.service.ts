import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import axios from 'axios';
import { errorMessage } from '../../common/error-message';

export interface IGetLinkParams {
  user_id: string;
  package_id: string;
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
  recurrence: '1 Month' | '1 Week';
  duration: 'Forever';
  type: string;
}

interface CancelSubscriptionResponse {
  status: 1 | -1;
  msg: string;
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
  }: IGetLinkParams): string {
    this.logger.log(
      `Generating PayHere payment link for order: ${order_id}, amount: ${amount} ${currency}, user: ${user_id}, package: ${package_id}`,
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
      return_url: String(process.env.PAYHERE_RETURN_URL),
      cancel_url: String(process.env.PAYHERE_CANCEL_URL),
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
      recurrence,
      duration,
      amount: amountFormatted,
      hash,
      custom_1: user_id,
      custom_2: package_id,
    };

    const link = `${this.getBaseUrl()}/pay/${type}?${new URLSearchParams(params).toString()}`;
    this.logger.log(
      `PayHere payment link generated successfully for order: ${order_id}`,
    );
    return link;
  }

  async getAccessToken(): Promise<string> {
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
      });

      this.logger.log(
        `PayHere OAuth token generated successfully (expires in ${response.data.expires_in}s)`,
      );
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
        },
      );

      this.logger.log(
        `PayHere subscription cancellation response for ${payhere_sub_id}: status=${response.data.status}, message=${response.data.msg}`,
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        `PayHere subscription cancellation failed for ${payhere_sub_id}: ${errorMessage(error)}`,
      );
      throw error;
    }
  }
}
