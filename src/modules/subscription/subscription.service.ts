import { Injectable } from '@nestjs/common';
import knexConfig from '../../../knexfile';
import Knex from 'knex';

const knex = Knex(knexConfig[process.env.NODE_ENV || 'development']);

export interface Subscription {
  id: string;
  user_id: string;
  package_id: string;
  created_at?: string;
  updated_at?: string;
}

@Injectable()
export class SubscriptionService {
  async getCurrentSubscriptionForUser(
    user_id: string,
  ): Promise<Subscription | undefined> {
    return await knex<Subscription>('subscription').where({ user_id }).first();
  }
}
