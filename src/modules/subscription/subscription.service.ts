import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import { PayHereService } from '../payhere/payhere.service';
import { Subscription, SubscriptionDetails } from '../../models/subscription';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import * as dayjs from 'dayjs';
import { errorMessage } from '../../common/error-message';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly payHereService: PayHereService,
    private readonly redisService: RedisService,
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

  /**
   * Record who a checkout is for before sending the user to PayHere. The
   * webhook resolves the subscription's owner from this row (by the signed
   * order_id), never from the payer-editable custom_1/custom_2.
   */
  async createPayHereOrder(
    order_id: string,
    user_id: string,
    package_id: string,
  ): Promise<void> {
    await this.knexService
      .knex('payhere_order')
      .insert({ order_id, user_id, package_id });
  }

  async getCurrentSubscriptionDetailsForUser(
    user_id: string,
  ): Promise<SubscriptionDetails | undefined> {
    const details = await this.redisService.getOrSet(
      CacheKeys.user.subscription(user_id),
      300,
      () => this.loadSubscriptionDetails(user_id),
    );
    return details ?? undefined;
  }

  private async loadSubscriptionDetails(
    user_id: string,
  ): Promise<SubscriptionDetails | undefined> {
    const result = await this.knexService
      .knex('subscription as s')
      .select(
        's.payhere_sub_id',
        's.user_id',
        's.package_id',
        's.is_active',
        's.payment_processor',
        's.created_at',
        's.updated_at',
        'p.name as package_name',
        'p.frequency',
        'p.amount as dca_price',
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
      nextBillingDate = startDate
        .add((weeksSinceStart + 1) * 7, 'day')
        .toDate();
    } else {
      // Monthly frequency
      const monthsSinceStart = now.diff(startDate, 'month');
      nextBillingDate = startDate.add(monthsSinceStart + 1, 'month').toDate();
    }

    const subscriptionDetails: SubscriptionDetails = {
      payhere_sub_id: result.payhere_sub_id,
      user_id: result.user_id,
      package_id: result.package_id,
      is_active: result.is_active,
      payment_processor: result.payment_processor,
      created_at: result.created_at,
      updated_at: result.updated_at,
      subscription_start_date: subscriptionStartDate,
      dca_price: result.dca_price,
      next_billing_date: nextBillingDate,
      package_name: result.package_name,
      frequency: result.frequency,
    };

    return subscriptionDetails;
  }

  async cancelPayHereSubscription(payhere_sub_id: string): Promise<void> {
    const trx = await this.knexService.knex.transaction();

    try {
      this.logger.log(
        `Starting atomic cancellation for subscription: ${payhere_sub_id}`,
      );

      // First, get the subscription to verify it exists and get user_id
      const subscription = await trx('subscription')
        .where('payhere_sub_id', payhere_sub_id)
        .first();

      if (!subscription) {
        throw new BadRequestException('Subscription not found');
      }

      // Call PayHere API to cancel subscription
      this.logger.log(
        `Attempting PayHere API cancellation for subscription: ${payhere_sub_id}`,
      );
      const result =
        await this.payHereService.cancelSubscription(payhere_sub_id);

      // Check if PayHere cancellation was successful
      if (!result || result.status !== 1) {
        throw new BadRequestException(
          `PayHere cancellation failed, status: ${result?.status || 'unknown'}`,
        );
      }

      // If PayHere API call succeeded, update database
      await trx('subscription')
        .update({
          is_active: false,
          updated_at: this.knexService.knex.fn.now(),
        })
        .where('payhere_sub_id', payhere_sub_id);

      // Commit transaction
      await trx.commit();

      // Invalidate cache after successful commit (non-critical operation)
      try {
        await this.invalidateUserSubscriptionCache(subscription.user_id);
      } catch (cacheError) {
        // Log cache error but don't fail the operation since DB operation succeeded
        this.logger.warn(
          `Failed to invalidate cache after successful cancellation of ${payhere_sub_id}: ${errorMessage(cacheError)}`,
        );
      }

      this.logger.log(
        `Subscription ${payhere_sub_id} successfully cancelled atomically`,
      );
    } catch (error) {
      // Rollback transaction on any error
      await trx.rollback();
      this.logger.error(
        `Atomic cancellation failed for subscription ${payhere_sub_id}: ${errorMessage(error)}`,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('Subscription cancellation failed');
    }
  }

  /**
   * Invalidate subscription cache for a user (call when subscription changes)
   */
  async invalidateUserSubscriptionCache(user_id: string): Promise<void> {
    const cacheKey = CacheKeys.user.subscription(user_id);
    await this.redisService.del(cacheKey);
    this.logger.log(`Invalidated subscription cache for user: ${user_id}`);
  }
}
