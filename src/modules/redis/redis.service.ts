import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import Redis from 'ioredis';

export interface CacheOptions {
  ttl?: number;
  compress?: boolean;
}

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private redis: Redis;

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {
    this.logger.log('Redis service initialized with cache manager');
    
    // Try to get Redis client for advanced operations (optional)
    setTimeout(() => {
      try {
        const store = (this.cacheManager as any).store;
        if (store && store.client) {
          this.redis = store.client;
          this.setupEventHandlers();
          this.logger.log('Redis direct client access enabled');
        }
      } catch (error) {
        this.logger.debug('Redis direct client not available, using cache manager only');
      }
    }, 1000);
  }

  private setupEventHandlers(): void {
    if (!this.redis) return;

    this.redis.on('connect', () => {
      this.logger.log('Redis connected successfully');
    });

    this.redis.on('error', (error) => {
      this.logger.error('Redis connection error:', error);
    });

    this.redis.on('ready', () => {
      this.logger.log('Redis is ready to accept commands');
    });

    this.redis.on('reconnecting', () => {
      this.logger.warn('Redis reconnecting...');
    });
  }

  /**
   * Check if caching is available (cache manager or direct Redis)
   */
  private isCacheAvailable(): boolean {
    return !!this.cacheManager;
  }

  /**
   * Check if direct Redis operations are available
   */
  private isRedisAvailable(): boolean {
    return !!this.redis;
  }

  /**
   * Get a value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isCacheAvailable()) {
      this.logger.debug(`Cache not available for key: ${key}`);
      return null;
    }
    
    try {
      const value = await this.cacheManager.get<T>(key);
      if (value) {
        this.logger.debug(`Cache HIT for key: ${key}`);
      } else {
        this.logger.debug(`Cache MISS for key: ${key}`);
      }
      return value || null;
    } catch (error) {
      this.logger.error(`Error getting cache key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set a value in cache
   */
  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    if (!this.isCacheAvailable()) {
      this.logger.debug(`Cache not available for key: ${key}`);
      return;
    }
    
    try {
      const ttl = options?.ttl ? options.ttl * 1000 : undefined; // Convert to milliseconds
      await this.cacheManager.set(key, value, ttl);
      this.logger.debug(`Cache SET for key: ${key}, TTL: ${options?.ttl || 'default'}`);
    } catch (error) {
      this.logger.error(`Error setting cache key ${key}:`, error);
    }
  }

  /**
   * Delete a key from cache
   */
  async del(key: string): Promise<void> {
    if (!this.isCacheAvailable()) {
      this.logger.debug(`Cache not available for key: ${key}`);
      return;
    }
    
    try {
      await this.cacheManager.del(key);
      this.logger.debug(`Cache DEL for key: ${key}`);
    } catch (error) {
      this.logger.error(`Error deleting cache key ${key}:`, error);
    }
  }

  /**
   * Get multiple keys at once
   */
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    try {
      const values = await Promise.all(keys.map(key => this.get<T>(key)));
      this.logger.debug(`Cache MGET for keys: ${keys.join(', ')}`);
      return values;
    } catch (error) {
      this.logger.error(`Error getting multiple cache keys:`, error);
      return keys.map(() => null);
    }
  }

  /**
   * Set multiple key-value pairs
   */
  async mset<T>(pairs: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    try {
      await Promise.all(
        pairs.map(pair => this.set(pair.key, pair.value, { ttl: pair.ttl }))
      );
      this.logger.debug(`Cache MSET for keys: ${pairs.map(p => p.key).join(', ')}`);
    } catch (error) {
      this.logger.error(`Error setting multiple cache keys:`, error);
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isRedisAvailable()) return false;
    
    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error checking cache key existence ${key}:`, error);
      return false;
    }
  }

  /**
   * Set expiration for a key
   */
  async expire(key: string, seconds: number): Promise<void> {
    if (!this.isRedisAvailable()) return;
    
    try {
      await this.redis.expire(key, seconds);
      this.logger.debug(`Cache EXPIRE for key: ${key}, seconds: ${seconds}`);
    } catch (error) {
      this.logger.error(`Error setting expiration for cache key ${key}:`, error);
    }
  }

  /**
   * Delete keys by pattern
   */
  async delByPattern(pattern: string): Promise<number> {
    if (!this.isRedisAvailable()) return 0;
    
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        const deleted = await this.redis.del(...keys);
        this.logger.debug(`Cache DEL by pattern: ${pattern}, deleted ${deleted} keys`);
        return deleted;
      }
      return 0;
    } catch (error) {
      this.logger.error(`Error deleting cache keys by pattern ${pattern}:`, error);
      return 0;
    }
  }

  /**
   * Clear all cache (use with caution)
   */
  async clear(): Promise<void> {
    if (!this.isRedisAvailable()) return;
    
    try {
      await this.redis.flushdb();
      this.logger.warn('Cache cleared (FLUSHDB)');
    } catch (error) {
      this.logger.error('Error clearing cache:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    keys: number;
    memoryUsage: string;
    hits: number;
    misses: number;
  }> {
    if (!this.isRedisAvailable()) {
      return { keys: 0, memoryUsage: '0B', hits: 0, misses: 0 };
    }
    
    try {
      const info = await this.redis.info('stats');
      const keyspace = await this.redis.info('keyspace');
      const memory = await this.redis.info('memory');

      // Parse info strings
      const statsMatch = info.match(/keyspace_hits:(\d+)/);
      const missesMatch = info.match(/keyspace_misses:(\d+)/);
      const memoryMatch = memory.match(/used_memory_human:([^\r\n]+)/);
      const keysMatch = keyspace.match(/keys=(\d+)/);

      return {
        keys: keysMatch ? parseInt(keysMatch[1]) : 0,
        memoryUsage: memoryMatch ? memoryMatch[1] : '0B',
        hits: statsMatch ? parseInt(statsMatch[1]) : 0,
        misses: missesMatch ? parseInt(missesMatch[1]) : 0,
      };
    } catch (error) {
      this.logger.error('Error getting cache stats:', error);
      return { keys: 0, memoryUsage: '0B', hits: 0, misses: 0 };
    }
  }

  /**
   * Generate cache key with consistent pattern
   */
  generateKey(prefix: string, ...parts: (string | number)[]): string {
    return `dca:${prefix}:${parts.join(':')}`;
  }

  /**
   * Invalidate user-specific caches
   */
  async invalidateUserCache(userId: string): Promise<void> {
    try {
      const patterns = [
        this.generateKey('subscription', 'user', userId),
        this.generateKey('transactions', 'user', userId, '*'),
        this.generateKey('transaction', 'latest', 'user', userId),
        this.generateKey('dca', 'summary', 'user', userId),
        this.generateKey('user', 'profile', userId),
      ];

      let totalDeleted = 0;
      for (const pattern of patterns) {
        const deleted = await this.delByPattern(pattern);
        totalDeleted += deleted;
      }

      this.logger.log(`Invalidated ${totalDeleted} cache entries for user ${userId}`);
    } catch (error) {
      this.logger.error(`Error invalidating user cache for ${userId}:`, error);
    }
  }

  /**
   * Warm up cache with frequently accessed data
   */
  async warmupCache(): Promise<void> {
    this.logger.log('Starting cache warmup...');
    // This will be implemented when we add specific cache warming strategies
    this.logger.log('Cache warmup completed');
  }
}