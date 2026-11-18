import { priceSale, usdtFor } from './sell.service';

describe('priceSale', () => {
  it('takes the fee in sats (rounded up) and prices the rest in LKR (rounded down)', () => {
    // 100,000 sats, 1% fee, 1 BTC = 20,000,000 LKR
    expect(priceSale(100_000, 100, 20_000_000)).toEqual({
      feeSats: 1000,
      netSats: 99_000,
      amountLkr: '19800.00',
    });
  });

  it('rounds a fractional fee up', () => {
    expect(priceSale(1001, 100, 20_000_000).feeSats).toBe(11);
  });

  it('never rounds LKR up', () => {
    // 12,345 sats at 21,444,240.35 LKR/BTC = 2647.29... LKR
    expect(priceSale(12_345, 0, 21_444_240.35).amountLkr).toBe('2647.29');
  });

  it('works with no fee', () => {
    expect(priceSale(50_000, 0, 20_000_000)).toEqual({
      feeSats: 0,
      netSats: 50_000,
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
