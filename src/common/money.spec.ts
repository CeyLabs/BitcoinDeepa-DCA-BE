import {
  ROUND_DOWN,
  ROUND_HALF_UP,
  ROUND_UP,
  basisPointsOf,
  formatLkr,
  isAmount,
  lkr,
  sameAmount,
  sats,
  sum,
  toApiNumber,
  toApiNumberOrNull,
  toFixed,
  toMoney,
  usdt,
} from './money';

describe('toMoney', () => {
  it('reads DB decimal strings exactly', () => {
    expect(toMoney('1234.56').toFixed()).toBe('1234.56');
    expect(toMoney('0.10').plus('0.20').toFixed()).toBe('0.3');
  });

  it('strips thousands separators', () => {
    expect(toMoney('1,000.00').toFixed(2)).toBe('1000.00');
  });

  it('treats null, undefined and empty as the fallback', () => {
    expect(toMoney(null).toFixed()).toBe('0');
    expect(toMoney(undefined).toFixed()).toBe('0');
    expect(toMoney('').toFixed()).toBe('0');
    expect(toMoney(null, 5).toFixed()).toBe('5');
    expect(toMoney(undefined, NaN).isNaN()).toBe(true);
  });

  it('never prints exponents', () => {
    expect(toMoney('1e21').toFixed()).toBe('1000000000000000000000');
    expect(toMoney(1e21).toString()).toBe('1000000000000000000000');
  });
});

describe('isAmount', () => {
  it.each(['0', '1000.00', '1,000', 10, '-5'])('accepts %p', (v) => {
    expect(isAmount(v)).toBe(true);
  });
  it.each(['', 'abc', '10.5LKR', 'NaN', null, undefined, Infinity])(
    'refuses %p',
    (v) => {
      expect(isAmount(v)).toBe(false);
    },
  );
});

describe('sameAmount', () => {
  it('compares to the cent, whatever the representation', () => {
    expect(sameAmount('1000', 1000)).toBe(true);
    expect(sameAmount('1000.00', '1,000')).toBe(true);
    expect(sameAmount('0.1', 0.1)).toBe(true);
    expect(sameAmount('1000.00', '1000.01')).toBe(false);
  });
  it('compares whole sats with dp 0', () => {
    expect(sameAmount('600', 600, 0)).toBe(true);
    expect(sameAmount('600', 601, 0)).toBe(false);
  });
  it('is false for anything that is not an amount', () => {
    expect(sameAmount('abc', 1)).toBe(false);
    expect(sameAmount(null, 0)).toBe(false);
  });
});

describe('rounding helpers', () => {
  it('lkr rounds as told, to 2 dp', () => {
    expect(lkr('10.005', ROUND_DOWN).toFixed(2)).toBe('10.00');
    expect(lkr('10.001', ROUND_UP).toFixed(2)).toBe('10.01');
    expect(lkr('10.005', ROUND_HALF_UP).toFixed(2)).toBe('10.01');
  });
  it('usdt rounds to 8 dp', () => {
    expect(usdt('0.123456789', ROUND_UP).toFixed(8)).toBe('0.12345679');
    expect(usdt('0.123456789', ROUND_DOWN).toFixed(8)).toBe('0.12345678');
  });
  it('sats rounds to a whole number', () => {
    expect(sats('599.9999', ROUND_DOWN).toFixed()).toBe('599');
    expect(sats('599.0001', ROUND_UP).toFixed()).toBe('600');
  });
});

describe('basisPointsOf', () => {
  it('is exact where floats are not', () => {
    // 1000 * 100 / 10000 = 10 exactly
    expect(basisPointsOf('1000', 100).toFixed()).toBe('10');
    // 0.1% of 0.3 LKR = 0.0003
    expect(basisPointsOf('0.3', 10).toFixed()).toBe('0.0003');
  });
});

describe('sum', () => {
  it('adds decimal strings exactly and skips nulls', () => {
    expect(sum(['0.1', '0.2', null, undefined, 0.3]).toFixed()).toBe('0.6');
    expect(sum([]).toFixed()).toBe('0');
  });
});

describe('API serialization', () => {
  it('toApiNumber returns a plain number', () => {
    expect(toApiNumber('1234.56')).toBe(1234.56);
    expect(toApiNumber(toMoney('600'))).toBe(600);
    expect(toApiNumber(null)).toBe(0);
  });
  it('toApiNumberOrNull keeps null', () => {
    expect(toApiNumberOrNull(null)).toBeNull();
    expect(toApiNumberOrNull(undefined)).toBeNull();
    expect(toApiNumberOrNull('')).toBeNull();
    expect(toApiNumberOrNull('0')).toBe(0);
  });
  it('toFixed gives a fixed-point string', () => {
    expect(toFixed('10.005', 2, ROUND_DOWN)).toBe('10.00');
    expect(toFixed(10, 2, ROUND_DOWN)).toBe('10.00');
  });
  it('formatLkr groups thousands at 2 dp', () => {
    expect(formatLkr('1234567.5')).toBe('1,234,567.50');
    expect(formatLkr(30)).toBe('30.00');
    expect(formatLkr('0.005')).toBe('0.01');
  });
});
