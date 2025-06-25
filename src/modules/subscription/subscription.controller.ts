import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import { SubscriptionService, Subscription } from './subscription.service';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('current')
  @UseGuards(ConditionalAuthGuard)
  async getCurrentSubscription(
    @CurrentUser() user: JwtPayload,
  ): Promise<Subscription> {
    const subscription =
      await this.subscriptionService.getCurrentSubscriptionForUser(
        user.user_id,
      );

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    return subscription;
  }
}
