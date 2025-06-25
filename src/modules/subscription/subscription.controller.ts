import { Controller, Get, Query, NotFoundException } from '@nestjs/common';
import { SubscriptionService, Subscription } from './subscription.service';

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('current')
  async getCurrentSubscription(
    @Query('user_id') user_id: string,
  ): Promise<Subscription> {
    const subscription =
      await this.subscriptionService.getCurrentSubscriptionForUser(user_id);

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    return subscription;
  }
}
