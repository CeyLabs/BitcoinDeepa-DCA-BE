import { computeBuyFees } from './buy-fees';

describe('computeBuyFees', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = {
      ...env,
      PAYHERE_FEE_BASIS_POINTS: '100',
      BITCOINDEEPA_FEE_BASIS_POINTS: '100',
    };
  });
  afterAll(() => {
    process.env = env;
  });

  it('matches the documented example (1000 LKR, 1% + 1%)', () => {
    expect(computeBuyFees(1000)).toEqual({
      gross: 1000,
      paymentProcessorFeeBps: 100,
      paymentProcessorFee: 10,
      bitcoindeepaFeeBps: 100,
      bitcoindeepaFee: 10,
      totalFees: 20,
      net: 980,
    });
  });

  it('takes the DB decimal string straight in', () => {
    expect(computeBuyFees('1000.00')).toEqual(computeBuyFees(1000));
  });

  it('is exact where float arithmetic drifts', () => {
    process.env.PAYHERE_FEE_BASIS_POINTS = '290';
    process.env.BITCOINDEEPA_FEE_BASIS_POINTS = '150';
    // 1234.56 × 0.029 = 35.80224; 1234.56 × 0.015 = 18.5184 (floats give
    // 35.802240000000005 and 18.518400000000003)
    const fees = computeBuyFees('1234.56');
    expect(fees.paymentProcessorFee).toBe(35.80224);
    expect(fees.bitcoindeepaFee).toBe(18.5184);
    expect(fees.totalFees).toBe(54.32064);
    expect(fees.net).toBe(1180.23936);
  });

  it('is zero fees when the env is unset', () => {
    delete process.env.PAYHERE_FEE_BASIS_POINTS;
    delete process.env.BITCOINDEEPA_FEE_BASIS_POINTS;
    expect(computeBuyFees(500).net).toBe(500);
  });
});
