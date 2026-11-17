/**
 * Live checks against the real price providers (CoinMarketCap + Ceylon Cash
 * FX). Skipped by default - they need network access and spend CMC quota.
 *
 *   RUN_LIVE_TESTS=1 LIVE_COINMARKETCAP_API_KEY=... bun run test:e2e
 */
import { CoinMarketCapService } from '../src/modules/coinmarketcap/coinmarketcap.service';
import { BitcoinPriceService } from '../src/modules/bitcoin-price/bitcoin-price.service';
import { RedisService } from '../src/modules/redis/redis.service';

const live =
  process.env.RUN_LIVE_TESTS === '1' &&
  !!process.env.LIVE_COINMARKETCAP_API_KEY;

(live ? describe : describe.skip)('Live price providers', () => {
  let price: BitcoinPriceService;

  beforeAll(() => {
    process.env.COINMARKETCAP_API_KEY = process.env.LIVE_COINMARKETCAP_API_KEY;
    // No Redis: every call goes to the providers.
    const redis = new RedisService();
    price = new BitcoinPriceService(redis, new CoinMarketCapService());
  });

  it('CoinMarketCap returns a sane BTC/USD price', async () => {
    const data = await new CoinMarketCapService().fetchBitcoinData();
    expect(data?.price).toBeGreaterThan(1_000);
    expect(typeof data?.percent_change_24h).toBe('number');
  });

  it('computes BTC in LKR and satoshis for a net amount', async () => {
    const current = await price.getCurrentPrice();
    expect(current?.lkr).toBeGreaterThan(current!.usd * 100); // USD/LKR > 100

    const calc = await price.calculateSatoshis(980, 'LKR');
    expect(calc?.currency).toBe('LKR');
    expect(calc?.satoshis).toBeGreaterThan(0);
    expect(calc!.satoshis).toBe(Math.floor((980 / calc!.btc_price) * 1e8));
  });

  it('only supports LKR', async () => {
    await expect(price.calculateSatoshis(10, 'USD')).resolves.toBeNull();
  });
});
