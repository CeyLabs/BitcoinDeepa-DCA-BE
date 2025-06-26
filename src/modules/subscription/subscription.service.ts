import { Injectable } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';

export interface Subscription {
  id: string;
  user_id: string;
  package_id: string;
  created_at?: string;
  updated_at?: string;
}

@Injectable()
export class SubscriptionService {
  constructor(private readonly knexService: KnexService) {}

  async getCurrentSubscriptionForUser(
    user_id: string,
  ): Promise<Subscription | undefined> {
    return await this.knexService
      .knex<Subscription>('subscription')
      .where({ user_id })
      .first();
  }
}
