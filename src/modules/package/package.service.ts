import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import Redis from 'ioredis';

export interface Package {
  id: string;
  name: string;
  frequency: 'weekly' | 'monthly';
  amount: number;
  currency: string;
  created_at?: string;
  updated_at?: string;
}

@Injectable()
export class PackageService implements OnModuleDestroy {
  private redis: Redis;

  constructor(
    private readonly knexService: KnexService,
    private readonly redisService: RedisService,
  ) {
    // Create direct Redis connection for reliable caching
    this.redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 3,
      connectTimeout: 30000,
      commandTimeout: 10000,
      lazyConnect: true,
      enableOfflineQueue: false,
      keepAlive: 30000,
    });

    // Handle Redis connection errors gracefully
    this.redis.on('error', (error) => {
      console.warn('Redis connection error in PackageService:', error.message);
    });

    this.redis.on('connect', () => {
      console.log('Redis connected in PackageService');
    });
  }

  async getAllPackages(): Promise<Package[]> {
    const cacheKey = CacheKeys.packages.all();

    try {
      // Try to get from Redis cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      // Silently fall through to database query
    }

    // If not in cache, fetch from database
    const packages = await this.knexService
      .knex<Package>('package')
      .select('*')
      .orderBy('frequency', 'desc')
      .orderBy('amount', 'asc');

    try {
      // Cache the result for 1 hour (3600 seconds) in Redis
      await this.redis.setex(cacheKey, 3600, JSON.stringify(packages));
    } catch (error) {
      // Silently ignore cache write failures
    }

    return packages;
  }

  async getPackageById(id: string): Promise<Package | undefined> {
    const cacheKey = CacheKeys.packages.byId(id);

    try {
      // Try to get from Redis cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      // Silently fall through to database query
    }

    // If not in cache, fetch from database
    const package_ = await this.knexService
      .knex<Package>('package')
      .where('id', id)
      .first();

    if (package_) {
      try {
        // Cache the result for 1 hour (3600 seconds) in Redis
        await this.redis.setex(cacheKey, 3600, JSON.stringify(package_));
      } catch (error) {
        // Silently ignore cache write failures
      }
    }

    return package_;
  }

  /**
   * Invalidate all package caches (call when packages are updated)
   */
  async invalidatePackageCache(): Promise<void> {
    try {
      const pattern = CacheKeys.patterns.allPackages();
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      // Silently ignore cache invalidation failures
    }
  }

  onModuleDestroy() {
    // Gracefully disconnect Redis when service is destroyed
    if (this.redis) {
      this.redis.disconnect();
    }
  }
}
