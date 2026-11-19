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

/**
 * Where a COLLECTING order's payment is (`sell_order.collect_state`, the app
 * sees it as `collect.state`). The bot's request and transfer statuses, in
 * its own lowercase words; anything it adds later is stored as PROCESSING.
 */
export enum CollectState {
  /** Asking the bot to create the request (no answer yet). View only, never stored */
  REQUESTING = 'requesting',
  /** Waiting for the user to approve */
  PENDING = 'pending',
  /** Approved; above the user's daily allowance, Confirm in the bot chat */
  AWAITING_CONFIRMATION = 'awaiting_confirmation',
  /** Approved; being paid */
  PROCESSING = 'processing',
  IN_FLIGHT = 'in_flight',
  COMPLETED = 'completed',
  /** The approved payment failed (e.g. low balance) */
  FAILED = 'failed',
  DECLINED = 'declined',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
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

/**
 * Orders left out of the member's history (/transaction/list): nothing was
 * sold. A quote not confirmed yet, and one that expired or was declined.
 */
export const NOT_IN_HISTORY_SELL_STATUSES = [
  SellStatus.QUOTED,
  SellStatus.EXPIRED,
];

export const DEFAULT_SELL_MAX_SATS = 5_000_000;
export const DEFAULT_SELL_DAILY_MAX_SATS = 20_000_000;

export const SATS_PER_BTC = 100_000_000;

/**
 * The memo of a sale's collect request: shown in the bot's Pay / Decline
 * prompt, and how the sale's payment is recognised in the user's bot history
 * (TransactionService.markSalePayments). Change it here only.
 */
export const saleCollectMemo = (amountLkr: string | number): string =>
  `Bitcoin Deepa sale: ${Number(amountLkr).toLocaleString('en-US', { minimumFractionDigits: 2 })} LKR to your bank account`;
