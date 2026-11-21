import axios, { AxiosError } from 'axios';
import { createHash } from 'crypto';
import {
  PayHereService,
  IGetLinkParams,
  payHereErrorDetail,
} from './payhere.service';

const md5 = (s: string) =>
  createHash('md5').update(s).digest('hex').toUpperCase();
const post = jest.spyOn(axios, 'post');
const get = jest.spyOn(axios, 'get');

const linkParams: IGetLinkParams = {
  user_id: '100000001',
  package_id: 'pkg-1',
  order_id: 'ORDER-1',
  amount: '1000',
  currency: 'LKR',
  first_name: 'Test',
  last_name: 'User',
  email: 't@example.com',
  phone: '0771234567',
  address: 'Street',
  city: 'Colombo',
  country: 'Sri Lanka',
  items: 'Shrimp Weekly',
  recurrence: '1 Week',
  duration: 'Forever',
  type: 'checkout',
};

describe('PayHereService', () => {
  // fresh instance per test: the OAuth token is cached on the service
  let service: PayHereService;
  const env = { ...process.env };

  beforeEach(() => {
    service = new PayHereService();
    process.env.PAYHERE_ENV = 'sandbox';
    process.env.PAYHERE_MERCHANT_ID = '1211111';
    process.env.PAYHERE_MERCHANT_SECRET = 'merchant-secret';
    process.env.PAYHERE_APP_ID = 'app-id';
    process.env.PAYHERE_APP_SECRET = 'app-secret';
    post.mockReset();
    get.mockReset();
  });
  afterAll(() => {
    process.env = env;
    post.mockRestore();
    get.mockRestore();
  });

  describe('getLink', () => {
    it('builds a checkout URL with the documented hash', () => {
      const url = new URL(service.getLink(linkParams));
      expect(url.origin + url.pathname).toBe(
        'https://sandbox.payhere.lk/pay/checkout',
      );
      const q = url.searchParams;
      expect(q.get('amount')).toBe('1000.00');
      // hash = MD5(merchant_id + order_id + amount + currency + MD5(secret)), uppercase
      expect(q.get('hash')).toBe(
        md5('1211111' + 'ORDER-1' + '1000.00' + 'LKR' + md5('merchant-secret')),
      );
      expect(q.get('recurrence')).toBe('1 Week');
      expect(q.get('custom_1')).toBe('100000001');
    });

    it('formats amounts with 2 decimals and no grouping', () => {
      const q = new URL(service.getLink({ ...linkParams, amount: '12345.5' }))
        .searchParams;
      expect(q.get('amount')).toBe('12345.50');
    });

    it('uses the live host when PAYHERE_ENV=live', () => {
      process.env.PAYHERE_ENV = 'live';
      expect(service.getLink(linkParams)).toMatch(
        /^https:\/\/www\.payhere\.lk\/pay\/checkout\?/,
      );
    });
  });

  describe('cancelSubscription', () => {
    it('gets an OAuth token, then cancels with it', async () => {
      post
        .mockResolvedValueOnce({
          data: { access_token: 'tok', expires_in: 600 },
        })
        .mockResolvedValueOnce({
          data: { status: 1, msg: 'Successfully cancelled the subscription' },
        });

      await expect(service.cancelSubscription('SUB-1')).resolves.toEqual({
        status: 1,
        msg: 'Successfully cancelled the subscription',
      });

      const [tokenUrl, tokenBody, tokenCfg] = post.mock.calls[0];
      expect(tokenUrl).toBe(
        'https://sandbox.payhere.lk/merchant/v1/oauth/token',
      );
      expect(String(tokenBody)).toBe('grant_type=client_credentials');
      expect(tokenCfg!.headers!.Authorization).toBe(
        `Basic ${Buffer.from('app-id:app-secret').toString('base64')}`,
      );

      const [cancelUrl, cancelBody, cancelCfg] = post.mock.calls[1];
      expect(cancelUrl).toBe(
        'https://sandbox.payhere.lk/merchant/v1/subscription/cancel',
      );
      expect(cancelBody).toEqual({ subscription_id: 'SUB-1' });
      expect(cancelCfg!.headers!.Authorization).toBe('Bearer tok');
    });

    it('returns PayHere refusals (status -1) to the caller', async () => {
      post
        .mockResolvedValueOnce({ data: { access_token: 'tok' } })
        .mockResolvedValueOnce({
          data: { status: -1, msg: 'Already cancelled' },
        });
      await expect(service.cancelSubscription('SUB-1')).resolves.toEqual({
        status: -1,
        msg: 'Already cancelled',
      });
    });

    it('fails without calling PayHere when app credentials are missing', async () => {
      delete process.env.PAYHERE_APP_SECRET;
      await expect(service.cancelSubscription('SUB-1')).rejects.toThrow(
        'PayHere App ID/Secret not set',
      );
      expect(post).not.toHaveBeenCalled();
    });

    it('propagates HTTP errors', async () => {
      post.mockRejectedValueOnce(new Error('401 Unauthorized'));
      await expect(service.cancelSubscription('SUB-1')).rejects.toThrow(
        '401 Unauthorized',
      );
    });
  });

  describe('getLink (one-off)', () => {
    it('leaves out recurrence/duration/custom_2; the hash is unchanged', () => {
      const oneOff: IGetLinkParams = {
        ...linkParams,
        package_id: undefined,
        recurrence: undefined,
        duration: undefined,
        items: 'Bitcoin purchase',
      };
      const q = new URL(service.getLink(oneOff)).searchParams;
      expect(q.get('recurrence')).toBeNull();
      expect(q.get('duration')).toBeNull();
      expect(q.get('custom_2')).toBeNull();
      expect(q.get('hash')).toBe(
        md5('1211111' + 'ORDER-1' + '1000.00' + 'LKR' + md5('merchant-secret')),
      );
    });

    it('keeps recurrence/duration on a subscription checkout', () => {
      const q = new URL(service.getLink(linkParams)).searchParams;
      expect(q.get('recurrence')).toBe('1 Week');
      expect(q.get('duration')).toBe('Forever');
      expect(q.get('custom_2')).toBe('pkg-1');
    });
  });

  describe('getPaymentsByOrderId', () => {
    it('lists the payments PayHere took for an order (Retrieval API)', async () => {
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockResolvedValueOnce({
        data: {
          status: 1,
          msg: 'Payments with order_id:ORDER-1',
          data: [
            {
              payment_id: 320025071278,
              order_id: 'ORDER-1',
              status: 'RECEIVED',
              amount: 1000,
            },
          ],
        },
      });

      await expect(service.getPaymentsByOrderId('ORDER-1')).resolves.toEqual([
        {
          payment_id: '320025071278',
          status: 'RECEIVED',
          amount: '1000',
          order_id: 'ORDER-1',
        },
      ]);
      const [url, cfg] = get.mock.calls[0];
      expect(url).toBe('https://sandbox.payhere.lk/merchant/v1/payment/search');
      expect(cfg!.params).toEqual({ order_id: 'ORDER-1' });
      expect(cfg!.headers!.Authorization).toBe('Bearer tok');
    });

    it('returns an empty list for "No payments found"', async () => {
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockResolvedValueOnce({
        data: { status: -1, msg: 'No payments found', data: null },
      });
      await expect(service.getPaymentsByOrderId('X')).resolves.toEqual([]);
    });

    it('throws on other PayHere error replies', async () => {
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockResolvedValueOnce({
        data: { status: -2, msg: 'Authentication error', data: null },
      });
      await expect(service.getPaymentsByOrderId('X')).rejects.toThrow(
        'Authentication error',
      );
    });
  });

  describe('getSubscriptionPayments', () => {
    it('lists the payments PayHere took for a subscription', async () => {
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockResolvedValueOnce({
        data: {
          status: 1,
          msg: 'Found 2 payments',
          data: [
            { payment_id: 320025023469, status: 'RECEIVED', amount: 1000 },
            { payment_id: 320025023470, status: 'CHARGEBACK', amount: 1000 },
          ],
        },
      });

      await expect(
        service.getSubscriptionPayments('420000032251'),
      ).resolves.toEqual([
        {
          payment_id: '320025023469',
          status: 'RECEIVED',
          amount: '1000',
          order_id: null,
        },
        {
          payment_id: '320025023470',
          status: 'CHARGEBACK',
          amount: '1000',
          order_id: null,
        },
      ]);
      const [url, cfg] = get.mock.calls[0];
      expect(url).toBe(
        'https://sandbox.payhere.lk/merchant/v1/subscription/420000032251/payments',
      );
      expect(cfg!.headers!.Authorization).toBe('Bearer tok');
    });

    it('treats a PayHere error reply (HTTP 200, status -1) as a failed lookup', async () => {
      // read as "no payments", it would make real payments look forged
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockResolvedValueOnce({
        data: { status: -1, msg: 'Unauthorized app' },
      });
      await expect(service.getSubscriptionPayments('1')).rejects.toThrow(
        'Unauthorized app',
      );
    });

    it('returns an empty list for status 1 without payments', async () => {
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockResolvedValueOnce({
        data: { status: 1, msg: 'Found 0 payments' },
      });
      await expect(service.getSubscriptionPayments('1')).resolves.toEqual([]);
    });

    it('throws on API errors (settlement retries later)', async () => {
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockRejectedValueOnce(new Error('503'));
      await expect(service.getSubscriptionPayments('1')).rejects.toThrow('503');
    });

    it('returns an empty list for "No payments found" (status -1)', async () => {
      // an error here would stop the order_id fallback ever running
      post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      get.mockResolvedValueOnce({
        data: { status: -1, msg: 'No payments found', data: null },
      });
      await expect(service.getSubscriptionPayments('1')).resolves.toEqual([]);
    });
  });

  describe('findPayment', () => {
    const listed = (payment_id: string, status = 'RECEIVED') => ({
      payment_id,
      order_id: 'ORDER-1',
      status,
      amount: 1000,
    });

    it('finds the payment by order_id (Retrieval API) without asking the Subscription Manager', async () => {
      post.mockResolvedValueOnce({
        data: { access_token: 'tok', expires_in: 600 },
      });
      get.mockResolvedValueOnce({
        data: { status: 1, msg: 'ok', data: [listed('P1')] },
      });
      await expect(
        service.findPayment('P1', 'ORDER-1', 'SUB-1'),
      ).resolves.toMatchObject({ payment_id: 'P1', status: 'RECEIVED' });
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("falls back to the subscription's payments when the order has none", async () => {
      post.mockResolvedValueOnce({
        data: { access_token: 'tok', expires_in: 600 },
      });
      get
        .mockResolvedValueOnce({
          data: { status: -1, msg: 'No payments found', data: null },
        })
        .mockResolvedValueOnce({
          data: { status: 1, msg: 'ok', data: [listed('P1')] },
        });
      await expect(
        service.findPayment('P1', 'ORDER-1', 'SUB-1'),
      ).resolves.toMatchObject({ payment_id: 'P1' });
      expect(get.mock.calls[1][0]).toContain('/subscription/SUB-1/payments');
    });

    it('is null for a payment_id PayHere lists nowhere', async () => {
      post.mockResolvedValueOnce({
        data: { access_token: 'tok', expires_in: 600 },
      });
      get
        .mockResolvedValueOnce({
          data: { status: 1, msg: 'ok', data: [listed('P1')] },
        })
        .mockResolvedValueOnce({
          data: { status: -1, msg: 'No payments found', data: null },
        });
      await expect(
        service.findPayment('INVENTED', 'ORDER-1', 'SUB-1'),
      ).resolves.toBeNull();
    });

    it('throws when PayHere fails (not the same as "not listed")', async () => {
      post.mockResolvedValueOnce({
        data: { access_token: 'tok', expires_in: 600 },
      });
      get.mockRejectedValueOnce(new Error('503'));
      await expect(service.findPayment('P1', 'ORDER-1')).rejects.toThrow('503');
    });
  });

  describe('OAuth token', () => {
    const token = (access_token: string, expires_in = 600) => ({
      data: { access_token, expires_in },
    });
    const payments = { data: { status: 1, data: [] } };

    it('is reused until it nearly expires, and every call has a timeout', async () => {
      post.mockResolvedValueOnce(token('tok-1'));
      get.mockResolvedValue(payments);
      await service.getSubscriptionPayments('1');
      await service.getSubscriptionPayments('1');
      expect(post).toHaveBeenCalledTimes(1);
      expect(get.mock.calls[1][1]!.headers!.Authorization).toBe('Bearer tok-1');
      expect(post.mock.calls[0][2]!.timeout).toBe(10000);
      expect(get.mock.calls[0][1]!.timeout).toBe(10000);
    });

    it('is refreshed when it is about to expire', async () => {
      // expires in 30s - inside the 60s safety margin
      post
        .mockResolvedValueOnce(token('tok-1', 30))
        .mockResolvedValueOnce(token('tok-2'));
      get.mockResolvedValue(payments);
      await service.getSubscriptionPayments('1');
      await service.getSubscriptionPayments('1');
      expect(post).toHaveBeenCalledTimes(2);
      expect(get.mock.calls[1][1]!.headers!.Authorization).toBe('Bearer tok-2');
    });

    it('is dropped when PayHere rejects it (401)', async () => {
      post
        .mockResolvedValueOnce(token('revoked'))
        .mockResolvedValueOnce(token('fresh'));
      get
        .mockRejectedValueOnce(
          new axios.AxiosError('Unauthorized', '401', undefined, undefined, {
            status: 401,
          } as never),
        )
        .mockResolvedValueOnce(payments);
      await expect(service.getSubscriptionPayments('1')).rejects.toThrow();
      await service.getSubscriptionPayments('1');
      expect(get.mock.calls[1][1]!.headers!.Authorization).toBe('Bearer fresh');
    });
  });
});

describe('payHereErrorDetail', () => {
  const rejected = (status: number, data: unknown) =>
    new AxiosError(
      `Request failed with status code ${status}`,
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      { status, data } as never,
    );

  it("adds PayHere's answer to the axios message", () => {
    const detail = payHereErrorDetail(
      rejected(401, {
        status: -1,
        msg: 'Access denied for the domain',
        data: null,
      }),
    );
    expect(detail).toContain('Request failed with status code 401');
    expect(detail).toContain('Access denied for the domain');
  });

  it('cuts the access token out of an invalid_token answer', () => {
    const token = 'cb5c47fd-741c-489a-b69e-fd73155ca34e';
    for (const description of [
      `Invalid access token: ${token}`,
      `Access token expired: ${token}`,
    ]) {
      const detail = payHereErrorDetail(
        rejected(401, {
          error: 'invalid_token',
          error_description: description,
        }),
      );
      expect(detail).toContain('invalid_token');
      expect(detail).not.toContain(token);
    }
  });

  it('is the plain message when there is no response', () => {
    expect(payHereErrorDetail(new Error('timeout'))).toBe('timeout');
    expect(payHereErrorDetail(new AxiosError('Network Error'))).toBe(
      'Network Error',
    );
  });
});
