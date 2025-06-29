import { Injectable } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';

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
  constructor(private readonly knexService: KnexService) {}

  async getAllPackages(): Promise<Package[]> {
    return this.knexService.knex<Package>('package').select('*');
  }

  async getPackageById(id: string): Promise<Package | undefined> {
    return this.knexService.knex<Package>('package').where('id', id).first();
  }
}
