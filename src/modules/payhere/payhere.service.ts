import md5 from 'crypto-js/md5';

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
    const hashedSecret: string = md5(
      String(process.env.PAYHERE_MERCHANT_SECRET),
    )
      .toString()
      .toUpperCase();
    const amountFormatted: string = parseFloat(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      useGrouping: false,
    });
    const hash: string = md5(
      String(process.env.PAYHERE_MERCHANT_ID) +
        order_id +
        amountFormatted +
        currency +
        hashedSecret,
    )
      .toString()
      .toUpperCase();

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
}
