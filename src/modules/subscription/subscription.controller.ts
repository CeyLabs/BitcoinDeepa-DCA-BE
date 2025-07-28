import {
  Controller,
  Get,
  NotFoundException,
  UseGuards,
  Post,
  Body,
  ConflictException,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionDetails } from '../../models/subscription';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { PayHereService } from '../payhere/payhere.service';
import { PackageService } from '../package/package.service';
import { UserService } from '../user/user.service';
import { randomUUID } from 'crypto';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';

@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly packageService: PackageService,
    private readonly userService: UserService,
    private readonly dbLogger: DatabaseLoggerService,
    private readonly payHereService: PayHereService,
    private readonly telegramLoggerService: TelegramLoggerService,
  ) {}

  @Get('current')
  @UseGuards(ConditionalAuthGuard)
  async getCurrentSubscription(
    @CurrentUser() user: JwtPayload,
  ): Promise<SubscriptionDetails> {
    await this.telegramLoggerService.logUserAction('Current Subscription (/subscription/current)', user);

    await this.dbLogger.info(
      `User ${user.id} retrieving current subscription`,
    );

    const subscription =
      await this.subscriptionService.getCurrentSubscriptionDetailsForUser(
        user.id,
      );

    if (!subscription) {
      await this.dbLogger.warn(
        `No subscription found for user ${user.id}`,
      );
      throw new NotFoundException('Subscription not found');
    }

    await this.dbLogger.info(
      `Subscription retrieved for user ${user.id}: ${subscription.payhere_sub_id}`,
    );
    return subscription;
  }

  @Post('payhere-link')
  @UseGuards(ConditionalAuthGuard)
  async getPayHereLink(
    @CurrentUser() user: JwtPayload,
    @Body() body: { package_id: string },
  ): Promise<{ link: string }> {
    await this.telegramLoggerService.logUserAction('Generate PayHere Link (/subscription/payhere-link)', user);

    await this.dbLogger.info(
      `User ${user.id} requesting payment link for package ${body.package_id}`,
    );

    // Check if user already has an active subscription
    const existingSubscription =
      await this.subscriptionService.getCurrentSubscriptionForUser(
        user.id,
      );
    if (existingSubscription && existingSubscription.is_active) {
      await this.dbLogger.warn(
        `User ${user.id} attempted to create new subscription while having active subscription ${existingSubscription.payhere_sub_id}`,
      );
      throw new ConflictException('User already has an active subscription');
    }

    const _package = await this.packageService.getPackageById(body.package_id);
    if (!_package) {
      await this.dbLogger.warn(
        `Package not found: ${body.package_id} for user ${user.id}`,
      );
      throw new NotFoundException('Package not found');
    }

    const _user = await this.userService.getUserById(user.id);
    if (!_user) {
      await this.dbLogger.error(
        `User not found in database: ${user.id}`,
      );
      throw new NotFoundException('User not found');
    }

    const orderId = randomUUID();
    const link = await this.payHereService.getLink({
      user_id: user.id,
      package_id: _package.id,
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

    await this.dbLogger.info(
      `Payment link generated for user ${user.id}, package: ${_package.name} (${_package.amount} ${_package.currency}), order: ${orderId}`,
    );
    return { link };
  }

  @Post('cancel')
  @UseGuards(ConditionalAuthGuard)
  async cancelCurrentSubscription(@CurrentUser() user: JwtPayload) {
    await this.telegramLoggerService.logUserAction('Cancel Subscription (/subscription/cancel)', user);

    await this.dbLogger.info(
      `User ${user.id} requesting subscription cancellation`,
    );

    const subscription =
      await this.subscriptionService.getCurrentSubscriptionForUser(
        user.id,
      );

    if (
      !subscription ||
      !subscription.payhere_sub_id ||
      !subscription.is_active
    ) {
      await this.dbLogger.warn(
        `Subscription cancellation failed - no active subscription found for user ${user.id}`,
      );
      throw new NotFoundException('Subscription not found');
    }

    await this.dbLogger.info(
      `Cancelling subscription ${subscription.payhere_sub_id} for user ${user.id}`,
    );
    await this.subscriptionService.cancelPayHereSubscription(
      subscription.payhere_sub_id,
    );

    await this.dbLogger.info(
      `Subscription ${subscription.payhere_sub_id} successfully cancelled for user ${user.id}`,
    );
    return { message: 'Subscription cancelled successfully' };
  }
}
