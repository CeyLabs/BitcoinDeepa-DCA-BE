import axios from 'axios';
import { BitcoinPriceService, btcLkrRate } from './bitcoin-price.service';
import { RedisService } from '../redis/redis.service';
import { CeyPayService } from '../ceypay/ceypay.service';
import { CoinMarketCapService } from '../coinmarketcap/coinmarketcap.service';

const get = jest.spyOn(axios, 'get');

describe('btcLkrRate', () => {
  it('is BTC/USD × USDT/LKR, rounded down to cents', () => {
    expect(btcLkrRate(65_000, 330)).toBe(21_450_000);
    // 62,655.37 × 331.737 = 20,785,104.47769
    expect(btcLkrRate(62_655.37, 331.737)).toBe(20_785_104.47);
  });
});

describe('BitcoinPriceService', () => {
  // No REDIS_URL in unit tests, so RedisService is a pass-through (no cache).
  const redis = new RedisService();
  const ceyPay = { getQuote: jest.fn() };
  const cmc = { fetchBitcoinData: jest.fn() };
  const service = new BitcoinPriceService(
    redis,
    ceyPay as unknown as CeyPayService,
    cmc as unknown as CoinMarketCapService,
  );

  beforeEach(() => {
    get.mockReset();
    ceyPay.getQuote.mockReset();
    get.mockResolvedValue({ data: { usd_price: 65000 } });
    ceyPay.getQuote.mockResolvedValue({ rateUsdtLkr: 330 });
    cmc.fetchBitcoinData.mockReset();
    cmc.fetchBitcoinData.mockResolvedValue({
      price: 99_999,
      percent_change_24h: 2,
    });
  });
  afterAll(() => get.mockRestore());

  it('BTC/LKR = Ceylon Cash BTC/USD × CeyPay USDT/LKR', async () => {
    await expect(service.getBtcLkrRate()).resolves.toEqual({
      btcLkr: 21_450_000,
      btcUsd: 65000,
      usdtLkr: 330,
    });
    expect(get.mock.calls[0][0]).toBe('https://fx.ceyloncash.com/currency/BTC');
    expect(ceyPay.getQuote).toHaveBeenCalledWith('1');
    // CoinMarketCap's price is never used
    expect(cmc.fetchBitcoinData).not.toHaveBeenCalled();
  });

  it('calculates satoshis in LKR, rounding down', async () => {
    // 980 LKR / 21,450,000 = 0.00004568764... BTC
    await expect(service.calculateSatoshis(980, 'LKR')).resolves.toEqual({
      satoshis: 4568,
      btc_price: 21_450_000,
      currency: 'LKR',
    });
  });

  it('only supports LKR', async () => {
    await expect(service.calculateSatoshis(980, 'USD')).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ['Ceylon Cash fails', () => get.mockRejectedValue(new Error('down'))],
    [
      'the BTC/USD price is invalid',
      () => get.mockResolvedValue({ data: { usd_price: 0 } }),
    ],
    [
      'the Ceylon Cash response is empty',
      () => get.mockResolvedValue({ data: {} }),
    ],
    [
      'CeyPay fails',
      () => ceyPay.getQuote.mockRejectedValue(new Error('down')),
    ],
    [
      'CeyPay has no rate',
      () => ceyPay.getQuote.mockResolvedValue({ rateUsdtLkr: 0 }),
    ],
  ])('returns null when %s', async (_, arrange) => {
    arrange();
    await expect(service.getBtcLkrRate()).resolves.toBeNull();
    await expect(service.calculateSatoshis(980, 'LKR')).resolves.toBeNull();
  });

  it('getUsdtLkr throws when CeyPay has no rate', async () => {
    ceyPay.getQuote.mockResolvedValue({ rateUsdtLkr: 0 });
    await expect(service.getUsdtLkr()).rejects.toThrow(
      'CeyPay returned no rate',
    );
  });

  it('exposes the CoinMarketCap 24h change (display only)', async () => {
    await expect(service.getBitcoin24HrChange()).resolves.toBe(2);
  });

  it('24h change is null when CoinMarketCap is unavailable', async () => {
    cmc.fetchBitcoinData.mockResolvedValue(null);
    await expect(service.getBitcoin24HrChange()).resolves.toBeNull();
  });
});
