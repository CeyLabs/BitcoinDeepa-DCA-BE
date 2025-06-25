import { Injectable } from '@nestjs/common';
import knexConfig from '../../../knexfile';
import Knex from 'knex';

const knex = Knex(knexConfig[process.env.NODE_ENV || 'development']);

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
  async getAllPackages(): Promise<Package[]> {
    return await knex<Package>('package').select('*');
  }
}
