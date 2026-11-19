import axios, { AxiosError } from 'axios';
import { Logger } from '@nestjs/common';
import { CoinMarketCapService } from './coinmarketcap.service';

const get = jest.spyOn(axios, 'get');

const ok = (
  entry: Record<string, unknown>,
  error_code: number | string = 0,
) => ({
  data: {
    data: [{ id: 1, ...entry }],
    status: { error_code, error_message: error_code ? 'bad' : null },
  },
});

describe('CoinMarketCapService.fetchBitcoinData', () => {
  const service = new CoinMarketCapService();

  beforeEach(() => {
    process.env.COINMARKETCAP_API_KEY = 'cmc-key';
    get.mockReset();
  });
  afterAll(() => get.mockRestore());

  it('returns BTC/USD price and 24h change', async () => {
    get.mockResolvedValue(ok({ price: 65000, percent_change_24h: -1.2 }));
    await expect(service.fetchBitcoinData()).resolves.toEqual({
      price: 65000,
      percent_change_24h: -1.2,
    });
    const [url, cfg] = get.mock.calls[0];
    expect(url).toBe('https://pro-api.coinmarketcap.com/v1/simple/price');
    expect(cfg!.params).toMatchObject({ ids: 1 });
    expect(cfg!.headers).toEqual({ 'X-CMC_PRO_API_KEY': 'cmc-key' });
  });

  it('accepts error_code as a numeric string', async () => {
    get.mockResolvedValue(ok({ price: 1, percent_change_24h: 0 }, '0'));
    await expect(service.fetchBitcoinData()).resolves.toMatchObject({
      price: 1,
    });
  });

  it.each([
    ['an API error', ok({ price: 65000 }, 1002)],
    ['a zero price', ok({ price: 0 })],
    ['a non-numeric price', ok({ price: '65000' })],
    ['no data', { data: { data: [], status: { error_code: 0 } } }],
  ])('returns null for %s', async (_, response) => {
    get.mockResolvedValue(response);
    await expect(service.fetchBitcoinData()).resolves.toBeNull();
  });

  it('returns null when the request fails', async () => {
    get.mockRejectedValue(new Error('ECONNRESET'));
    await expect(service.fetchBitcoinData()).resolves.toBeNull();
  });

  it('logs a failure as one line, never the error object', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    get.mockRejectedValue(
      Object.assign(new AxiosError('Request failed with status code 401'), {
        response: { status: 401, data: {} },
      }),
    );
    await expect(service.fetchBitcoinData()).resolves.toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toHaveLength(1); // a message, no object
    expect(error.mock.calls[0][0]).toBe(
      'CoinMarketCap request failed (HTTP 401): Request failed with status code 401 - check COINMARKETCAP_API_KEY',
    );
    error.mockRestore();
  });

  describe('failure kinds (how long callers wait before retrying)', () => {
    const httpError = (status: number) =>
      Object.assign(new AxiosError('Request failed'), {
        response: { status, data: {} },
      });
    let error: jest.SpyInstance;
    beforeEach(() => {
      error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
    });
    afterEach(() => error.mockRestore());

    it.each([401, 403, 429])(
      '%i is PERSISTENT (key, plan, rate limit)',
      async (status) => {
        get.mockRejectedValue(httpError(status));
        await expect(service.fetchBitcoinDataResult()).resolves.toEqual({
          failure: 'PERSISTENT',
        });
      },
    );

    it.each([1002, '1002'])(
      'an API error code in the body (%p) is PERSISTENT',
      async (code) => {
        get.mockResolvedValue(ok({ price: 1 }, code));
        await expect(service.fetchBitcoinDataResult()).resolves.toEqual({
          failure: 'PERSISTENT',
        });
      },
    );

    it.each([
      ['an empty status', { status: {} }],
      ['no status', {}],
      ['a non-numeric code', { status: { error_code: 'oops' } }],
      ['an empty code', { status: { error_code: '' } }],
    ])('a body with %s is TRANSIENT', async (_, body) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      get.mockResolvedValue({ data: { data: [{ id: 1, price: 1 }], ...body } });
      await expect(service.fetchBitcoinDataResult()).resolves.toEqual({
        failure: 'TRANSIENT',
      });
    });

    it.each([
      ['a 5xx', () => get.mockRejectedValue(httpError(503))],
      [
        'a timeout',
        () => get.mockRejectedValue(new AxiosError('timeout', 'ECONNABORTED')),
      ],
      ['a bad payload', () => get.mockResolvedValue(ok({ price: 0 }))],
    ])('%s is TRANSIENT', async (_, arrange) => {
      arrange();
      await expect(service.fetchBitcoinDataResult()).resolves.toEqual({
        failure: 'TRANSIENT',
      });
    });

    it('returns the data on success', async () => {
      get.mockResolvedValue(ok({ price: 65000, percent_change_24h: 1.2 }));
      await expect(service.fetchBitcoinDataResult()).resolves.toEqual({
        data: { price: 65000, percent_change_24h: 1.2 },
      });
    });
  });
});
