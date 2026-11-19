import axios from 'axios';
import {
  BitcoinPriceService,
  btcLkrRate,
  satoshisFor,
} from './bitcoin-price.service';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { CeyPayError, CeyPayService } from '../ceypay/ceypay.service';
import { CoinMarketCapService } from '../coinmarketcap/coinmarketcap.service';

const get = jest.spyOn(axios, 'get');

describe('btcLkrRate', () => {
  it('is BTC/USD × USDT/LKR, rounded down to cents', () => {
    expect(btcLkrRate(65_000, 330)).toBe(21_450_000);
    // 62,655.37 × 331.737 = 20,785,104.47769
    expect(btcLkrRate(62_655.37, 331.737)).toBe(20_785_104.47);
  });
});

describe('satoshisFor', () => {
  it('rounds down to whole sats', () => {
    // 980 / 21,450,000 = 0.00004568764... BTC
    expect(satoshisFor(980, 21_450_000)).toBe(4568);
    expect(satoshisFor('980.00', '21450000.00')).toBe(4568);
  });

  it('is exact where float division comes out one sat short', () => {
    // Exactly 600 sats; (128.7 / 21450000) * 1e8 is 599.9999999999999
    expect(Math.floor((128.7 / 21_450_000) * 100_000_000)).toBe(599);
    expect(satoshisFor(128.7, 21_450_000)).toBe(600);
    expect(satoshisFor(47.19, 21_450_000)).toBe(220);
  });
});

describe('BitcoinPriceService', () => {
  // No REDIS_URL in unit tests, so RedisService is a pass-through (no cache).
  const redis = new RedisService();
  const ceyPay = { getQuote: jest.fn() };
  const cmc = { fetchBitcoinData: jest.fn() };
  // exchange_rate_log: `latest` is what the "recent row" query finds
  let latest: Record<string, unknown> | undefined;
  const insert = jest.fn();
  const update = jest.fn();
  const query = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn(() => Promise.resolve(latest)),
    insert,
    update,
  };
  const raw = jest.fn((sql: string, bindings?: unknown[]) => ({
    sql,
    bindings,
  }));
  const trx = Object.assign(jest.fn().mockReturnValue(query), { raw });
  const knex = Object.assign(jest.fn().mockReturnValue(query), {
    raw,
    transaction: jest.fn((work: (t: typeof trx) => Promise<void>) => work(trx)),
  });
  const service = new BitcoinPriceService(
    redis,
    ceyPay as unknown as CeyPayService,
    cmc as unknown as CoinMarketCapService,
    { knex } as unknown as KnexService,
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
    latest = undefined;
    insert.mockReset();
    insert.mockResolvedValue([]);
    update.mockReset();
    update.mockResolvedValue(1);
    query.where.mockClear();
    query.first.mockClear();
    delete process.env.EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS;
  });
  afterAll(() => get.mockRestore());

  it('BTC/LKR = Ceylon Cash BTC/USD × CeyPay USDT/LKR', async () => {
    await expect(service.getBtcLkrRate()).resolves.toEqual({
      btcLkr: 21_450_000,
      btcUsd: 65000,
      usdtLkr: 330,
    });
    expect(get.mock.calls[0][0]).toBe('https://fx.ceyloncash.com/currency/BTC');
    // Short timeout: a price lookup must fail fast, not hang a request
    expect(ceyPay.getQuote).toHaveBeenCalledWith('1', { timeoutMs: 3000 });
    expect(get.mock.calls[0][1]).toEqual({ timeout: 3000 });
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

  describe('exchange rate log', () => {
    const logged = {
      btc_usd: '64000.00000000',
      usdt_lkr: '330.00000000',
      btc_lkr: '21120000.00',
      age_seconds: 42,
    };

    it('records the live rate as the active row, deactivating the last one', async () => {
      await service.recordExchangeRate();
      expect(trx).toHaveBeenCalledWith('exchange_rate_log');
      expect(query.where).toHaveBeenCalledWith('is_active', true);
      expect(update).toHaveBeenCalledWith({ is_active: false });
      expect(insert).toHaveBeenCalledWith({
        btc_usd: 65000,
        usdt_lkr: 330,
        btc_lkr: 21_450_000,
        is_active: true,
      });
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(
        insert.mock.invocationCallOrder[0],
      );
    });

    it('records nothing while the price is unavailable', async () => {
      get.mockRejectedValue(new Error('down'));
      await service.recordExchangeRate();
      expect(insert).not.toHaveBeenCalled();
      // The last good rate stays active
      expect(update).not.toHaveBeenCalled();
    });

    it('a failed insert does not throw (it runs in a cron)', async () => {
      insert.mockRejectedValue(new Error('db down'));
      await expect(service.recordExchangeRate()).resolves.toBeUndefined();
    });

    it('prices a payment from the latest recent row when the live price is down', async () => {
      get.mockRejectedValue(new Error('down'));
      latest = logged;
      // 980 / 21,120,000 = 0.00004640151... BTC
      await expect(service.calculateSatoshis(980, 'LKR')).resolves.toEqual({
        satoshis: 4640,
        btc_price: 21_120_000,
        currency: 'LKR',
      });
      // Only the active row, within the max age (default 5 min)
      expect(query.where).toHaveBeenCalledWith('is_active', true);
      expect(query.where).toHaveBeenCalledWith(
        'created_at',
        '>=',
        expect.objectContaining({ bindings: [300] }),
      );
    });

    it('uses the live price when there is one, not the log', async () => {
      latest = logged;
      await expect(
        service.calculateSatoshis(980, 'LKR'),
      ).resolves.toMatchObject({ btc_price: 21_450_000 });
      expect(query.first).not.toHaveBeenCalled();
    });

    it('the max age is configurable, and 0 turns the fallback off', async () => {
      get.mockRejectedValue(new Error('down'));
      latest = logged;
      process.env.EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS = '120';
      await service.calculateSatoshis(980, 'LKR');
      expect(query.where).toHaveBeenCalledWith(
        'created_at',
        '>=',
        expect.objectContaining({ bindings: [120] }),
      );

      process.env.EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS = '0';
      await expect(service.calculateSatoshis(980, 'LKR')).resolves.toBeNull();
    });

    it('quotes and displayed prices never use the log', async () => {
      get.mockRejectedValue(new Error('down'));
      latest = logged;
      await expect(service.getBtcLkrRate()).resolves.toBeNull();
      await expect(service.getBitcoinPrice('LKR')).resolves.toBeNull();
    });

    it('a failed lookup is treated as no rate', async () => {
      get.mockRejectedValue(new Error('down'));
      query.first.mockRejectedValueOnce(new Error('db down'));
      await expect(service.calculateSatoshis(980, 'LKR')).resolves.toBeNull();
    });
  });

  it('getUsdtLkr passes on CeyPay errors', async () => {
    ceyPay.getQuote.mockRejectedValue(new CeyPayError('down', 503, true));
    await expect(service.getUsdtLkr()).rejects.toThrow('down');
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
