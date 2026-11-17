import axios from 'axios';
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
});
