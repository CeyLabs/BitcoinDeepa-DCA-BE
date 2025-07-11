import { Injectable, BadRequestException } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import { PayHereService } from '../payhere/payhere.service';
import { Subscription, SubscriptionDetails } from '../../models/subscription';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import * as dayjs from 'dayjs';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly knexService: KnexService,
    private readonly dbLogger: DatabaseLoggerService,
    private readonly payHereService: PayHereService,
  ) {}

  async getCurrentSubscriptionForUser(
    user_id: string,
  ): Promise<Subscription | undefined> {
    return this.knexService
      .knex<Subscription>('subscription')
      .where({ user_id })
      .orderBy('created_at', 'desc')
      .first();
  }

  async getCurrentSubscriptionDetailsForUser(
    user_id: string,
  ): Promise<SubscriptionDetails | undefined> {
    const result = await this.knexService
      .knex('subscription as s')
      .select(
        's.payhere_sub_id',
        's.user_id',
        's.package_id',
        's.is_active',
        's.created_at',
        's.updated_at',
        'p.name as package_name',
        'p.frequency',
        'p.amount as dca_price'
      )
      .join('package as p', 's.package_id', 'p.id')
      .where('s.user_id', user_id)
      .andWhere('s.is_active', true)
      .orderBy('s.created_at', 'desc')
      .first();

    if (!result) {
      return undefined;
    }

    // Calculate subscription start date (use created_at of subscription)
    const subscriptionStartDate = new Date(result.created_at);
    
    // Calculate next billing date based on frequency and start date
    let nextBillingDate: Date;
    const now = dayjs();
    const startDate = dayjs(subscriptionStartDate);
    
    if (result.frequency === 'weekly') {
      // Find the next weekly billing date
      const daysSinceStart = now.diff(startDate, 'day');
      const weeksSinceStart = Math.floor(daysSinceStart / 7);
      nextBillingDate = startDate.add((weeksSinceStart + 1) * 7, 'day').toDate();
    } else {
      // Monthly frequency
      const monthsSinceStart = now.diff(startDate, 'month');
      nextBillingDate = startDate.add(monthsSinceStart + 1, 'month').toDate();
    }

    return {
      payhere_sub_id: result.payhere_sub_id,
      user_id: result.user_id,
      package_id: result.package_id,
      is_active: result.is_active,
      created_at: result.created_at,
      updated_at: result.updated_at,
      subscription_start_date: subscriptionStartDate,
      dca_price: result.dca_price,
      next_billing_date: nextBillingDate,
      package_name: result.package_name,
      frequency: result.frequency,
    };
  }

  async cancelPayHereSubscription(payhere_sub_id: string): Promise<void> {
    try {
      await this.dbLogger.info(`Attempting PayHere API cancellation for subscription: ${payhere_sub_id}`);
      const result = await this.payHereService.cancelSubscription(payhere_sub_id);
      
      if (result && result.status === 1) {
        await this.knexService
          .knex('subscription')
          .update({ is_active: false })
          .where('payhere_sub_id', payhere_sub_id);
        
        await this.dbLogger.info(`Subscription ${payhere_sub_id} marked as inactive in database`);
      } else {
        await this.dbLogger.warn(`PayHere cancellation failed for subscription ${payhere_sub_id}, status: ${result?.status}`);
      }
    } catch (error) {
      await this.dbLogger.error(`PayHere API error during cancellation of subscription ${payhere_sub_id}: ${error.message}`);
      throw new BadRequestException('PayHere API error');
    }
  }
}
