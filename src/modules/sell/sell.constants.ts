export enum SellStatus {
  /** Priced, waiting for the user to confirm before expires_at */
  QUOTED = 'QUOTED',
  /** Not confirmed in time; nothing was moved */
  EXPIRED = 'EXPIRED',
  /** Sats taken from the user; CeyPay payout not created yet */
  SATS_COLLECTED = 'SATS_COLLECTED',
  /** CeyPay off-ramp created; waiting for its webhook */
  PAYOUT_PENDING = 'PAYOUT_PENDING',
  /** LKR paid to the user's bank */
  COMPLETED = 'COMPLETED',
  /** Payout failed and the sats were returned */
  REFUNDED = 'REFUNDED',
  /** A transfer outcome is unknown; a human must check before anything else */
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

/** Orders whose bank account must not be removed */
export const IN_FLIGHT_SELL_STATUSES = [
  SellStatus.QUOTED,
  SellStatus.SATS_COLLECTED,
  SellStatus.PAYOUT_PENDING,
  SellStatus.NEEDS_REVIEW,
];

export const SATS_PER_BTC = 100_000_000;
