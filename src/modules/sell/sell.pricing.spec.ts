import { ceyPayWebhookUrl, priceSale, usdtFor } from './sell.service';

describe('priceSale', () => {
  it('prices the whole sale (rounded down) and takes the fee in LKR (rounded up)', () => {
    // 100,000 sats, 1% fee, 1 BTC = 20,000,000 LKR
    expect(priceSale(100_000, 100, 20_000_000)).toEqual({
      grossLkr: '20000.00',
      feeLkr: '200.00',
      amountLkr: '19800.00',
    });
  });

  it('rounds a fractional fee up to the cent', () => {
    // 1% of 2647.29 = 26.4729
    expect(priceSale(12_345, 100, 21_444_240.35)).toEqual({
      grossLkr: '2647.29',
      feeLkr: '26.48',
      amountLkr: '2620.81',
    });
  });

  it('works with no fee', () => {
    expect(priceSale(50_000, 0, 20_000_000)).toEqual({
      grossLkr: '10000.00',
      feeLkr: '0.00',
      amountLkr: '10000.00',
    });
  });
});

describe('usdtFor', () => {
  it('sizes USDT so CeyPay pays at least the LKR amount', () => {
    const usdt = usdtFor('19800.00', 330.5);
    expect(usdt).toBe('59.90922845');
    expect(Number(usdt) * 330.5).toBeGreaterThanOrEqual(19800);
  });
});

describe('ceyPayWebhookUrl', () => {
  it('prefers CEYPAY_WEBHOOK_URL', () => {
    expect(
      ceyPayWebhookUrl({
        CEYPAY_WEBHOOK_URL: 'https://hooks.example.com/x',
        BASE_URL: 'https://api.example.com',
      }),
    ).toBe('https://hooks.example.com/x');
  });

  it('derives it from a public https BASE_URL', () => {
    expect(ceyPayWebhookUrl({ BASE_URL: 'https://api.example.com/' })).toBe(
      'https://api.example.com/sell/ceypay-webhook',
    );
  });

  it('sends none for a local or missing BASE_URL (CeyPay would refuse it)', () => {
    expect(
      ceyPayWebhookUrl({ BASE_URL: 'http://localhost:3100' }),
    ).toBeUndefined();
    expect(ceyPayWebhookUrl({ BASE_URL: 'https://localhost' })).toBeUndefined();
    expect(ceyPayWebhookUrl({ BASE_URL: 'not a url' })).toBeUndefined();
    expect(ceyPayWebhookUrl({})).toBeUndefined();
  });
});
