export enum SellStatus {
  /** Priced, waiting for the user to confirm before expires_at */
  QUOTED = 'QUOTED',
  /** Not confirmed in time; nothing was moved */
  EXPIRED = 'EXPIRED',
  /** Confirmed; the bot debit is in progress (committed before it starts) */
  COLLECTING = 'COLLECTING',
  /** Sats taken from the user; CeyPay payout not created yet */
  SATS_COLLECTED = 'SATS_COLLECTED',
  /** CeyPay off-ramp created; waiting for its webhook */
  PAYOUT_PENDING = 'PAYOUT_PENDING',
  /** LKR paid to the user's bank */
  COMPLETED = 'COMPLETED',
  /** Payout failed; the sats are being returned */
  REFUNDING = 'REFUNDING',
  /** Payout failed and the sats were returned */
  REFUNDED = 'REFUNDED',
  /** A transfer outcome is unknown; a human must check before anything else */
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

/** Orders whose bank account must not be removed */
export const IN_FLIGHT_SELL_STATUSES = [
  SellStatus.QUOTED,
  SellStatus.COLLECTING,
  SellStatus.SATS_COLLECTED,
  SellStatus.PAYOUT_PENDING,
  SellStatus.REFUNDING,
  SellStatus.NEEDS_REVIEW,
];

/**
 * Orders whose sats count toward the daily limit: taken from the wallet, or
 * about to be. REFUNDING counts until the sats are actually back.
 */
export const COUNTED_SELL_STATUSES = [
  SellStatus.COLLECTING,
  SellStatus.SATS_COLLECTED,
  SellStatus.PAYOUT_PENDING,
  SellStatus.COMPLETED,
  SellStatus.REFUNDING,
  SellStatus.NEEDS_REVIEW,
];

export const DEFAULT_SELL_MAX_SATS = 5_000_000;
export const DEFAULT_SELL_DAILY_MAX_SATS = 20_000_000;

export const SATS_PER_BTC = 100_000_000;
