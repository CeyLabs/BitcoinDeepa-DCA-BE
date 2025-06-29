import { Injectable, BadRequestException } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import { PayHereService } from '../payhere/payhere.service';

export interface Subscription {
  id: string;
  user_id: string;
  package_id: string;
  payhere_sub_id?: string;
  created_at?: string;
  updated_at?: string;
}

@Injectable()
export class SubscriptionService {
  constructor(private readonly knexService: KnexService) {}

  async getCurrentSubscriptionForUser(
    user_id: string,
  ): Promise<Subscription | undefined> {
    return this.knexService
      .knex<Subscription>('subscription')
      .where({ user_id })
      .first();
  }

  async cancelPayHereSubscription(payhere_sub_id: string): Promise<void> {
    try {
      const result = await PayHereService.cancelSubscription(payhere_sub_id);
      if (result && result.status === 1) {
        await this.knexService
          .knex('subscription')
          .update({ is_active: false })
          .where('payhere_sub_id', payhere_sub_id);
      }
    } catch {
      throw new BadRequestException('PayHere API error');
    }
  }
}
