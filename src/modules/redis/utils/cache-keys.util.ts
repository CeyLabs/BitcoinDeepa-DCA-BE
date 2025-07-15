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
    profile: (userId: string): string =>
      `${CacheKeys.PREFIX}:user:profile:${userId}`,
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
  };

  // PayHere-related cache keys
  static payhere = {
    token: (): string => `${CacheKeys.PREFIX}:payhere:token`,
  };

  // Pattern generators for bulk operations
  static patterns = {
    userAll: (userId: string): string =>
      `${CacheKeys.PREFIX}:*:user:${userId}*`,
    userTransactions: (userId: string): string =>
      `${CacheKeys.PREFIX}:transaction*:user:${userId}*`,
    allPackages: (): string => `${CacheKeys.PREFIX}:packages:*`,
    allBitcoinPrices: (): string => `${CacheKeys.PREFIX}:btc:*`,
  };
}
