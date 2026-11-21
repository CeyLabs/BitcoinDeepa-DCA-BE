import { Injectable } from '@nestjs/common';
import { toApiNumber } from '../../common/money';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';

export interface Package {
  id: string;
  name: string;
  frequency: 'weekly' | 'monthly';
  /** Whole LKR (a decimal column: pg reads it as a string, see `fromRow`) */
  amount: number;
  currency: string;
  created_at?: string;
  updated_at?: string;
}

const PACKAGE_CACHE_TTL_SECONDS = 3600;

type PackageRow = Omit<Package, 'amount'> & { amount: number | string };

/** API serialization point: package amounts are whole LKR, exact as numbers */
const fromRow = (row: PackageRow): Package => ({
  ...row,
  amount: toApiNumber(row.amount),
});

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
      async () =>
        (
          await this.knexService
            .knex<PackageRow>('package')
            .select('*')
            .orderBy('frequency', 'desc')
            .orderBy('amount', 'asc')
        ).map(fromRow),
    );
    return packages ?? [];
  }

  async getPackageById(id: string): Promise<Package | undefined> {
    const package_ = await this.redisService.getOrSet(
      CacheKeys.packages.byId(id),
      PACKAGE_CACHE_TTL_SECONDS,
      async () => {
        const row = await this.knexService
          .knex<PackageRow>('package')
          .where('id', id)
          .first();
        return row ? fromRow(row) : undefined;
      },
    );
    return package_ ?? undefined;
  }
}
