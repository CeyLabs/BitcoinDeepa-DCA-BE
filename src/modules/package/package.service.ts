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
    const packages = await this.redisService.getOrSet(
      CacheKeys.packages.all(),
      PACKAGE_CACHE_TTL_SECONDS,
      () =>
        this.knexService
          .knex<Package>('package')
          .select('*')
          .orderBy('frequency', 'desc')
          .orderBy('amount', 'asc'),
    );
    return packages ?? [];
  }

  async getPackageById(id: string): Promise<Package | undefined> {
    const package_ = await this.redisService.getOrSet(
      CacheKeys.packages.byId(id),
      PACKAGE_CACHE_TTL_SECONDS,
      () => this.knexService.knex<Package>('package').where('id', id).first(),
    );
    return package_ ?? undefined;
  }
}
