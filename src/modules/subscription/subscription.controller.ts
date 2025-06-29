import {
  Controller,
  Get,
  NotFoundException,
  UseGuards,
  Post,
  Body,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { Subscription } from '../../models/subscription';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { PayHereService } from '../payhere/payhere.service';
import { PackageService } from '../package/package.service';
import { UserService } from '../user/user.service';

@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly packageService: PackageService,
    private readonly userService: UserService,
  ) {}

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

  @Post('payhere-link')
  async getPayHereLink(
    @CurrentUser() user: JwtPayload,
    @Body() body: { package_id: string },
  ): Promise<{ link: string }> {
    const _package = await this.packageService.getPackageById(body.package_id);
    if (!_package) {
      throw new NotFoundException('Package not found');
    }

    const _user = await this.userService.getUserById(user.user_id);

    const link = PayHereService.getLink({
      user_id: user.user_id,
      order_id: '-',
      amount: String(_package.amount),
      currency: _package.currency,
      first_name: _user!.first_name,
      last_name: _user!.first_name,
      email: _user!.email,
      phone: _user!.phone,
      address: _user!.address,
      city: _user!.city,
      country: _user!.country,
      items: _package.name,
      recurrence: _package.frequency === 'weekly' ? '1 Week' : '1 Month',
      duration: 'Forever',
      type: 'checkout',
    });
    return { link };
  }

  @Post('cancel')
  @UseGuards(ConditionalAuthGuard)
  async cancelCurrentSubscription(@CurrentUser() user: JwtPayload) {
    const subscription =
      await this.subscriptionService.getCurrentSubscriptionForUser(
        user.user_id,
      );
    if (!subscription || !subscription.payhere_sub_id) {
      throw new NotFoundException('Subscription not found');
    }

    await this.subscriptionService.cancelPayHereSubscription(
      subscription.payhere_sub_id,
    );

    return;
  }
}
