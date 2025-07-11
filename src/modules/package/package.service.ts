import { Injectable } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';

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
export class PackageService {
  constructor(
    private readonly knexService: KnexService,
    private readonly redisService: RedisService,
  ) {}

  async getAllPackages(): Promise<Package[]> {
    const cacheKey = CacheKeys.packages.all();
    
    // Try to get from cache first
    const cached = await this.redisService.get<Package[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // If not in cache, fetch from database
    const packages = await this.knexService.knex<Package>('package').select('*');
    
    // Cache the result for 1 hour (3600 seconds)
    await this.redisService.set(cacheKey, packages, { ttl: 3600 });
    
    return packages;
  }

  async getPackageById(id: string): Promise<Package | undefined> {
    const cacheKey = CacheKeys.packages.byId(id);
    
    // Try to get from cache first
    const cached = await this.redisService.get<Package>(cacheKey);
    if (cached) {
      return cached;
    }

    // If not in cache, fetch from database
    const package_ = await this.knexService.knex<Package>('package').where('id', id).first();
    
    if (package_) {
      // Cache the result for 1 hour (3600 seconds)
      await this.redisService.set(cacheKey, package_, { ttl: 3600 });
    }
    
    return package_;
  }

  /**
   * Invalidate all package caches (call when packages are updated)
   */
  async invalidatePackageCache(): Promise<void> {
    await this.redisService.delByPattern(CacheKeys.patterns.allPackages());
  }
}
