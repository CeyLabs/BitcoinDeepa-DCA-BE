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
import { randomUUID } from 'crypto';
import { DatabaseLoggerService } from '../knex/database-logger.service';

@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly packageService: PackageService,
    private readonly userService: UserService,
    private readonly dbLogger: DatabaseLoggerService,
    private readonly payHereService: PayHereService,
  ) {}

  @Get('current')
  @UseGuards(ConditionalAuthGuard)
  async getCurrentSubscription(
    @CurrentUser() user: JwtPayload,
  ): Promise<Subscription> {
    await this.dbLogger.info(`User ${user.telegram_id} retrieving current subscription`);
    
    const subscription =
      await this.subscriptionService.getCurrentSubscriptionForUser(
        user.user_id,
      );

    if (!subscription) {
      await this.dbLogger.warn(`No subscription found for user ${user.telegram_id}`);
      throw new NotFoundException('Subscription not found');
    }

    await this.dbLogger.info(`Subscription retrieved for user ${user.telegram_id}: ${subscription.payhere_sub_id}`);
    return subscription;
  }

  @Post('payhere-link')
  @UseGuards(ConditionalAuthGuard)
  async getPayHereLink(
    @CurrentUser() user: JwtPayload,
    @Body() body: { package_id: string },
  ): Promise<{ link: string }> {
    await this.dbLogger.info(`User ${user.telegram_id} requesting payment link for package ${body.package_id}`);
    
    const _package = await this.packageService.getPackageById(body.package_id);
    if (!_package) {
      await this.dbLogger.warn(`Package not found: ${body.package_id} for user ${user.telegram_id}`);
      throw new NotFoundException('Package not found');
    }

    const _user = await this.userService.getUserById(user.user_id);
    if (!_user) {
      await this.dbLogger.error(`User not found in database: ${user.user_id} (${user.telegram_id})`);
      throw new NotFoundException('User not found');
    }

    const orderId = randomUUID();
    const link = await this.payHereService.getLink({
      user_id: user.user_id,
      order_id: orderId,
      amount: String(_package.amount),
      currency: _package.currency,
      first_name: _user.first_name,
      last_name: _user.last_name,
      email: _user.email,
      phone: _user.phone,
      address: _user.address,
      city: _user.city,
      country: _user.country,
      items: _package.name,
      recurrence: _package.frequency === 'weekly' ? '1 Week' : '1 Month',
      duration: 'Forever',
      type: 'checkout',
    });
    
    await this.dbLogger.info(`Payment link generated for user ${user.telegram_id}, package: ${_package.name} (${_package.amount} ${_package.currency}), order: ${orderId}`);
    return { link };
  }

  @Post('cancel')
  @UseGuards(ConditionalAuthGuard)
  async cancelCurrentSubscription(@CurrentUser() user: JwtPayload) {
    await this.dbLogger.info(`User ${user.telegram_id} requesting subscription cancellation`);
    
    const subscription =
      await this.subscriptionService.getCurrentSubscriptionForUser(
        user.user_id,
      );
    if (!subscription || !subscription.payhere_sub_id) {
      await this.dbLogger.warn(`Subscription cancellation failed - no active subscription found for user ${user.telegram_id}`);
      throw new NotFoundException('Subscription not found');
    }

    await this.dbLogger.info(`Cancelling subscription ${subscription.payhere_sub_id} for user ${user.telegram_id}`);
    await this.subscriptionService.cancelPayHereSubscription(
      subscription.payhere_sub_id,
    );
    
    await this.dbLogger.info(`Subscription ${subscription.payhere_sub_id} successfully cancelled for user ${user.telegram_id}`);
    return;
  }
}
