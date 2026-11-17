import axios from 'axios';
import { BitcoinPriceService } from './bitcoin-price.service';
import { RedisService } from '../redis/redis.service';
import { CoinMarketCapService } from '../coinmarketcap/coinmarketcap.service';

const get = jest.spyOn(axios, 'get');

describe('BitcoinPriceService', () => {
  // No REDIS_URL in unit tests, so RedisService is a pass-through (no cache).
  const redis = new RedisService();
  const cmc = { fetchBitcoinData: jest.fn() };
  const service = new BitcoinPriceService(
    redis,
    cmc as unknown as CoinMarketCapService,
  );

  beforeEach(() => {
    get.mockReset();
    cmc.fetchBitcoinData.mockReset();
    cmc.fetchBitcoinData.mockResolvedValue({
      price: 65000,
      percent_change_24h: 2,
    });
    get.mockResolvedValue({ data: { selling_rate: 300 } });
  });
  afterAll(() => get.mockRestore());

  it('LKR price = BTC/USD × USD/LKR selling rate', async () => {
    await expect(service.getBitcoinPrice('lkr')).resolves.toEqual({
      btc_price: 19_500_000,
      currency: 'LKR',
    });
    expect(get.mock.calls[0][0]).toBe('https://fx.ceyloncash.com/currency/USD');
  });

  it('calculates satoshis, rounding down', async () => {
    // 980 LKR / 19,500,000 = 0.0000502564... BTC
    await expect(service.calculateSatoshis(980, 'LKR')).resolves.toEqual({
      satoshis: 5025,
      btc_price: 19_500_000,
      currency: 'LKR',
    });
  });

  it('only supports LKR', async () => {
    await expect(service.calculateSatoshis(980, 'USD')).resolves.toBeNull();
    expect(cmc.fetchBitcoinData).not.toHaveBeenCalled();
  });

  it('returns null when BTC price is unavailable', async () => {
    cmc.fetchBitcoinData.mockResolvedValue(null);
    await expect(service.calculateSatoshis(980, 'LKR')).resolves.toBeNull();
  });

  it.each([
    ['the FX API fails', () => get.mockRejectedValue(new Error('down'))],
    [
      'the FX rate is invalid',
      () => get.mockResolvedValue({ data: { selling_rate: 0 } }),
    ],
    ['the FX response is empty', () => get.mockResolvedValue({ data: {} })],
  ])('returns null when %s', async (_, arrange) => {
    arrange();
    await expect(service.calculateSatoshis(980, 'LKR')).resolves.toBeNull();
  });

  it('exposes the 24h change', async () => {
    await expect(service.getBitcoin24HrChange()).resolves.toBe(2);
  });
});
