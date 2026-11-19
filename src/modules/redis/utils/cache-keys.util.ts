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
    price: (currency: string): string =>
      `${CacheKeys.PREFIX}:btc:price:${currency}`,
    usdLkr: (): string => `${CacheKeys.PREFIX}:exchange:usd:lkr`,
    ceylonCashBtcUsd: (): string =>
      `${CacheKeys.PREFIX}:exchange:btc-usd:ceyloncash`,
  };

  // Sell flow cache keys
  static sell = {
    banks: (): string => `${CacheKeys.PREFIX}:sell:banks`,
    ceypayRate: (): string => `${CacheKeys.PREFIX}:sell:ceypay:usdt-lkr`,
  };

  // Pattern generators for bulk operations
  static patterns = {
    userTransactionLists: (userId: string): string =>
      `${CacheKeys.PREFIX}:transactions:user:${userId}:*`,
    allBitcoinPrices: (): string => `${CacheKeys.PREFIX}:btc:*`,
  };
}
