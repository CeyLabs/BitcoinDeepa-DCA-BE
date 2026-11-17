import axios from 'axios';
import { createHmac } from 'crypto';
import { BitcoinDeepaService } from './bitcoindeepa.service';

const post = jest.spyOn(axios, 'post');

describe('BitcoinDeepaService', () => {
  let service: BitcoinDeepaService;

  beforeEach(() => {
    process.env.BITCOINDEEPA_API_URL = 'https://bd.test';
    process.env.BITCOINDEEPA_HMAC_SECRET = 'hmac-secret';
    service = new BitcoinDeepaService();
    post.mockReset();
  });

  it('signs METHOD + PATH + TIMESTAMP + BODY with HMAC-SHA256', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true } });
    await service.transferFunds(1000, '42', 'memo');

    const [url, body, config] = post.mock.calls[0];
    const headers = config!.headers as Record<string, string>;
    expect(url).toBe('https://bd.test/api/v1/send');
    expect(JSON.parse(body as string)).toEqual({
      amount: 1000,
      to: '42',
      memo: 'memo',
    });
    const expected = createHmac('sha256', 'hmac-secret')
      .update(`POST/api/v1/send${headers['X-Timestamp']}${body as string}`)
      .digest('hex');
    expect(headers['X-HMAC-Signature']).toBe(expected);
  });

  it('returns the API response on success', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { success: true, transaction_id: 't1' },
    });
    await expect(service.transferFunds(1, '42', 'm')).resolves.toEqual({
      success: true,
      transaction_id: 't1',
    });
  });

  it('flags a timeout (no response) as outcome_unknown', async () => {
    post.mockRejectedValue(
      Object.assign(new Error('timeout of 10000ms exceeded'), {}),
    );
    await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
      success: false,
      outcome_unknown: true,
    });
  });

  it.each([502, 503, 504])(
    'flags a %i gateway error as outcome_unknown',
    async (status) => {
      post.mockRejectedValue({
        message: 'Bad gateway',
        response: { status, data: {} },
      });
      await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
        success: false,
        outcome_unknown: true,
      });
    },
  );

  it('treats "already completed" errors as done', async () => {
    post.mockRejectedValue({
      message: 'Request failed',
      response: { status: 409, data: { error: 'Transfer already completed' } },
    });
    await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
      success: false,
      already_completed: true,
    });
  });

  it('returns a plain failure for other API errors', async () => {
    post.mockRejectedValue({
      message: 'Request failed',
      response: { status: 400, data: { error: 'Insufficient balance' } },
    });
    const result = await service.transferFunds(1, '42', 'm');
    expect(result).toMatchObject({
      success: false,
      message: 'Insufficient balance',
      already_completed: false,
    });
    expect(result.outcome_unknown).toBeUndefined();
  });

  it('fetches bot transaction history with limit/offset', async () => {
    const data = {
      success: true,
      telegram_id: 42,
      count: 1,
      transactions: [{}],
    };
    post.mockResolvedValue({ status: 200, data });
    await expect(service.getUserTransactions(42, 50, 10)).resolves.toEqual(
      data,
    );
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('https://bd.test/api/v1/usertransactions');
    expect(JSON.parse(body as string)).toEqual({
      telegram_id: 42,
      limit: 50,
      offset: 10,
    });
  });

  it('returns an empty history when the API fails', async () => {
    post.mockRejectedValue({
      message: 'Request failed',
      response: { status: 500, data: {} },
    });
    await expect(
      service.getUserTransactions(42, 50, 10),
    ).resolves.toMatchObject({
      success: false,
      telegram_id: 42,
      count: 0,
      limit: 50,
      offset: 10,
      transactions: [],
    });
  });

  it('returns a failure when the balance API fails', async () => {
    post.mockRejectedValue(new Error('down'));
    await expect(service.getUserBalance(42)).resolves.toMatchObject({
      success: false,
    });
  });

  it('is not configured without URL and secret', () => {
    process.env.BITCOINDEEPA_API_URL = '';
    expect(new BitcoinDeepaService().isConfigured()).toBe(false);
  });
});
