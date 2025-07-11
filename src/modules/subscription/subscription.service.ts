import { Injectable, BadRequestException } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import { PayHereService } from '../payhere/payhere.service';
import { Subscription } from '../../models/subscription';
import { DatabaseLoggerService } from '../knex/database-logger.service';

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
      .first();
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
