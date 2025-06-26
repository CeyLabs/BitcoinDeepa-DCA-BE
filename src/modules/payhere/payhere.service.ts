import md5 from 'crypto-js/md5';
import axios from 'axios';

export interface IGetLinkParams {
  user_id: string;
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return md5(input).toString();
  } catch {
    return '';
  }
}

export class PayHereService {
  static getBaseUrl(): string {
    return (process.env.PAYHERE_ENV as string) === 'live'
      ? 'https://www.payhere.lk'
      : 'https://sandbox.payhere.lk';
  }

  static getLink({
    user_id,
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
    };

    return `${PayHereService.getBaseUrl()}/pay/${type}?${new URLSearchParams(params).toString()}`;
  }

  static async getAccessToken(): Promise<string> {
    const appId = process.env.PAYHERE_APP_ID;
    const appSecret = process.env.PAYHERE_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('PayHere App ID/Secret not set');
    }
    const authCode = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    const url = `${this.getBaseUrl()}/oauth/token`;

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
    return response.data.access_token;
  }

  static async cancelSubscription(
    payhere_sub_id: string,
  ): Promise<CancelSubscriptionResponse> {
    const accessToken = await PayHereService.getAccessToken();

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
    return response.data;
  }
}
