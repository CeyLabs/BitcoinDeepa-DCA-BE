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

const PACKAGE_CACHE_TTL_SECONDS = 3600;

@Injectable()
export class PackageService {
  constructor(
    private readonly knexService: KnexService,
    private readonly redisService: RedisService,
  ) {}

  async getAllPackages(): Promise<Package[]> {
    const cacheKey = CacheKeys.packages.all();
    const cached = await this.redisService.get<Package[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const packages = await this.knexService
      .knex<Package>('package')
      .select('*')
      .orderBy('frequency', 'desc')
      .orderBy('amount', 'asc');

    await this.redisService.set(cacheKey, packages, {
      ttl: PACKAGE_CACHE_TTL_SECONDS,
    });
    return packages;
  }

  async getPackageById(id: string): Promise<Package | undefined> {
    const cacheKey = CacheKeys.packages.byId(id);
    const cached = await this.redisService.get<Package>(cacheKey);
    if (cached) {
      return cached;
    }

    const package_ = await this.knexService
      .knex<Package>('package')
      .where('id', id)
      .first();

    if (package_) {
      await this.redisService.set(cacheKey, package_, {
        ttl: PACKAGE_CACHE_TTL_SECONDS,
      });
    }
    return package_;
  }
}
