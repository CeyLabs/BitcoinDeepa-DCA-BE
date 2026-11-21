/**
 * Utility class for generating consistent cache keys
 */
export class CacheKeys {
  private static readonly PREFIX = 'dca';

  // Package-related cache keys
  static packages = {
    all: (): string => `${CacheKeys.PREFIX}:packages:all`,
    byId: (id: string): string => `${CacheKeys.PREFIX}:packages:id:${id}`,
  };

  // User-related cache keys
  static user = {
    subscription: (userId: string): string =>
      `${CacheKeys.PREFIX}:subscription:user:${userId}`,
  };

  // Transaction-related cache keys
  static transaction = {
    // /transaction/list. `history` (was `transactions`) since pages hold
    // BUY and SELL items: a new build never serves a page cached in the
    // old shape, and an old build never serves one in the new shape.
    list: (userId: string, page: number, limit: number): string =>
      `${CacheKeys.PREFIX}:history:user:${userId}:page:${page}:limit:${limit}`,
    latest: (userId: string): string =>
      `${CacheKeys.PREFIX}:transaction:latest:user:${userId}`,
    dcaSummary: (userId: string): string =>
      `${CacheKeys.PREFIX}:dca:summary:user:${userId}`,
  };

  // Bitcoin price cache keys
  static bitcoin = {
    ceylonCashBtcUsd: (): string => `${CacheKeys.PREFIX}:btc:usd:ceyloncash`,
    ceypayUsdtLkr: (): string => `${CacheKeys.PREFIX}:btc:usdt-lkr:ceypay`,
    cmc24hChange: (): string => `${CacheKeys.PREFIX}:btc:change-24h:cmc`,
    // Not under btc:* - clearing the price cache must not release the claim
    rateLogClaim: (): string => `${CacheKeys.PREFIX}:rate-log:claim`,
  };

  // Sell flow cache keys
  static sell = {
    banks: (): string => `${CacheKeys.PREFIX}:sell:banks`,
    // An order read asks the bot about its collect request at most this often
    collectSync: (orderId: string): string =>
      `${CacheKeys.PREFIX}:sell:collect-sync:${orderId}`,
    // "Collect is failing because of our setup" alert, at most hourly
    collectUnavailableAlert: (): string =>
      `${CacheKeys.PREFIX}:alert:sell-collect-unavailable`,
  };

  // PayHere webhook: per-order counters (not under btc:* or history:*, so
  // clearing a cache never resets them)
  static payhere = {
    // PayHere API lookups the webhook made for an order this hour
    lookups: (orderId: string): string =>
      `${CacheKeys.PREFIX}:payhere:lookups:${orderId}`,
    // Refused/throttled notifications for an order this hour (alert throttle)
    refusedAlerts: (orderId: string): string =>
      `${CacheKeys.PREFIX}:payhere:refused:${orderId}`,
  };

  // P2P relay
  static p2p = {
    webIdToken: (userId: string): string =>
      `${CacheKeys.PREFIX}:p2p:id-token:${userId}`,
  };

  // Pattern generators for bulk operations
  static patterns = {
    userTransactionLists: (userId: string): string =>
      `${CacheKeys.PREFIX}:history:user:${userId}:*`,
    allBitcoinPrices: (): string => `${CacheKeys.PREFIX}:btc:*`,
  };
}
