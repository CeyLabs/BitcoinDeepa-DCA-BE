import { BigNumber } from 'bignumber.js';

/**
 * Money and amount arithmetic for the whole backend. Floats are never used
 * for LKR, sats, USD/USDT or rates: 0.1 + 0.2 is not 0.3, and a Postgres
 * `decimal` arrives from `pg` as a string that `Number()` would quietly
 * round. Keep values as BigNumber (or the DB's decimal string) through a
 * calculation and only convert at the edges (DB writes, API responses).
 *
 * Rounding is always explicit at the call site: `lkr(x, ROUND_DOWN)`,
 * `BigNumber#decimalPlaces(2, ROUND_UP)`. The clone below only sets what
 * applies to division and string output, so no implicit rounding sneaks in
 * from a global default.
 */
export const Money = BigNumber.clone({
  // Division keeps plenty of precision; callers round to 2 or 8 dp themselves
  DECIMAL_PLACES: 20,
  ROUNDING_MODE: BigNumber.ROUND_DOWN,
  // Never print exponents ("1e+21") for anything we'd store or display
  EXPONENTIAL_AT: [-1e9, 1e9],
});
export type Money = BigNumber;

export const ROUND_DOWN = BigNumber.ROUND_DOWN;
export const ROUND_UP = BigNumber.ROUND_UP;
export const ROUND_HALF_UP = BigNumber.ROUND_HALF_UP;

export const SATOSHIS_PER_BTC = 100_000_000;
export const BASIS_POINTS = 10_000;
export const LKR_DP = 2;
export const USDT_DP = 8;

export type Numeric = BigNumber | string | number | null | undefined;

/**
 * Any amount we get handed (a DB decimal string, a number, a BigNumber) as a
 * BigNumber. Commas are stripped ("1,000.00"). `null`/`undefined`/'' become
 * `fallback` (0 unless given), so sums over nullable columns just work.
 * Anything that isn't a finite number is NaN: check with `isAmount` first
 * when the value came from outside.
 */
export function toMoney(value: Numeric, fallback: Numeric = 0): Money {
  if (value == null || value === '') return new Money(fallback ?? 0);
  if (BigNumber.isBigNumber(value)) return new Money(value);
  if (typeof value === 'string') {
    return new Money(value.replace(/,/g, '').trim());
  }
  return new Money(value);
}

/** True when `value` parses as a finite number (negative allowed). */
export function isAmount(value: Numeric): boolean {
  if (value == null || value === '') return false;
  return toMoney(value).isFinite();
}

/** Same amount to the cent (or to `dp`), "1000" == "1000.00" == 1000. */
export function sameAmount(
  a: Numeric,
  b: Numeric,
  dp: number = LKR_DP,
): boolean {
  const x = toMoney(a, NaN);
  const y = toMoney(b, NaN);
  return (
    x.isFinite() &&
    y.isFinite() &&
    x
      .decimalPlaces(dp, ROUND_HALF_UP)
      .isEqualTo(y.decimalPlaces(dp, ROUND_HALF_UP))
  );
}

/** LKR amount at 2 dp, rounded as told (no default: say which way). */
export const lkr = (value: Numeric, rounding: BigNumber.RoundingMode): Money =>
  toMoney(value).decimalPlaces(LKR_DP, rounding);

/** USDT amount at 8 dp, rounded as told. */
export const usdt = (value: Numeric, rounding: BigNumber.RoundingMode): Money =>
  toMoney(value).decimalPlaces(USDT_DP, rounding);

/** Whole sats, rounded as told. */
export const sats = (value: Numeric, rounding: BigNumber.RoundingMode): Money =>
  toMoney(value).decimalPlaces(0, rounding);

/** `bps` basis points of `amount` (not rounded; round at the call site). */
export const basisPointsOf = (amount: Numeric, bps: Numeric): Money =>
  toMoney(amount).times(toMoney(bps)).div(BASIS_POINTS);

/** Sum of amounts; nulls count as 0. */
export const sum = (values: Iterable<Numeric>): Money => {
  let total = new Money(0);
  for (const v of values) total = total.plus(toMoney(v));
  return total;
};

/**
 * A BigNumber as a JS number for an API response that returns numbers.
 * Only for values that fit a double exactly: whole sats (well under
 * MAX_SAFE_INTEGER) and 2-dp LKR for display. Not for further arithmetic.
 */
export const toApiNumber = (value: Numeric): number =>
  toMoney(value).toNumber();

/** A nullable DB decimal as a number for an API response, null kept. */
export const toApiNumberOrNull = (value: Numeric): number | null =>
  value == null || value === '' ? null : toApiNumber(value);

/** Fixed-point string for the DB or an API field that returns strings. */
export const toFixed = (
  value: Numeric,
  dp: number,
  rounding: BigNumber.RoundingMode,
): string => toMoney(value).toFixed(dp, rounding);

/**
 * "1,234.50": a 2-dp LKR amount with thousands grouping, for memos and
 * messages. Rounds half up; the input is normally already at 2 dp.
 */
export const formatLkr = (value: Numeric): string =>
  lkr(value, ROUND_HALF_UP).toFormat(LKR_DP, ROUND_HALF_UP, {
    decimalSeparator: '.',
    groupSeparator: ',',
    groupSize: 3,
  });
