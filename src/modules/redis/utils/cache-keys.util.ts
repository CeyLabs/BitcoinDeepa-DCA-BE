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
    list: (userId: string, page: number, limit: number): string =>
      `${CacheKeys.PREFIX}:transactions:user:${userId}:page:${page}:limit:${limit}`,
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
  };

  // P2P relay
  static p2p = {
    webIdToken: (userId: string): string =>
      `${CacheKeys.PREFIX}:p2p:id-token:${userId}`,
  };

  // Pattern generators for bulk operations
  static patterns = {
    userTransactionLists: (userId: string): string =>
      `${CacheKeys.PREFIX}:transactions:user:${userId}:*`,
    allBitcoinPrices: (): string => `${CacheKeys.PREFIX}:btc:*`,
  };
}
