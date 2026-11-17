import {
  Controller,
  Get,
  NotFoundException,
  UseGuards,
  Post,
  Body,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionDetails } from '../../models/subscription';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { KycVerifiedGuard } from '../auth/kyc-verified.guard';
import { RequireKyc } from '../auth/require-kyc.decorator';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { PayHereService } from '../payhere/payhere.service';
import { PackageService } from '../package/package.service';
import { UserService } from '../user/user.service';
import { randomUUID } from 'crypto';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { PayHereLinkDto } from './dto/payhere-link.dto';

@Controller('subscription')
export class SubscriptionController {
  private readonly logger = new Logger(SubscriptionController.name);

  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly packageService: PackageService,
    private readonly userService: UserService,
    private readonly payHereService: PayHereService,
    private readonly telegramLoggerService: TelegramLoggerService,
  ) {}

  @Get('current')
  @UseGuards(ConditionalAuthGuard)
  async getCurrentSubscription(
    @CurrentUser() user: JwtPayload,
  ): Promise<SubscriptionDetails> {
    return this.telegramLoggerService.trackAction(
      'Current Subscription (/subscription/current)',
      user,
      async () => {
        const subscription =
          await this.subscriptionService.getCurrentSubscriptionDetailsForUser(
            user.id,
          );
        if (!subscription) {
          throw new NotFoundException('Subscription not found');
        }
        return subscription;
      },
    );
  }

  @Post('payhere-link')
  @UseGuards(ConditionalAuthGuard, KycVerifiedGuard)
  @RequireKyc()
  async getPayHereLink(
    @CurrentUser() user: JwtPayload,
    @Body() body: PayHereLinkDto,
  ): Promise<{ link: string }> {
    return this.telegramLoggerService.trackAction(
      'Generate PayHere Link (/subscription/payhere-link)',
      user,
      async () => {
        const existingSubscription =
          await this.subscriptionService.getCurrentSubscriptionForUser(user.id);
        if (existingSubscription?.is_active) {
          throw new ConflictException(
            'User already has an active subscription',
          );
        }

        const _package = await this.packageService.getPackageById(
          body.package_id,
        );
        if (!_package) {
          throw new NotFoundException('Package not found');
        }

        const _user = await this.userService.getUserOrThrow(user.id);
        if (!this.userService.isProfileComplete(_user)) {
          throw new BadRequestException(
            'Please complete your profile before subscribing',
          );
        }

        const orderId = randomUUID();
        await this.subscriptionService.createPayHereOrder(
          orderId,
          user.id,
          _package.id,
        );
        const link = this.payHereService.getLink({
          user_id: user.id,
          package_id: _package.id,
          order_id: orderId,
          amount: String(_package.amount),
          currency: _package.currency,
          first_name: _user.first_name,
          last_name: _user.last_name ?? '',
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

        this.logger.log(
          `Payment link generated for user ${user.id}, package ${_package.name} (${_package.amount} ${_package.currency}), order ${orderId}`,
        );
        return { link };
      },
    );
  }

  @Post('cancel')
  @UseGuards(ConditionalAuthGuard)
  async cancelCurrentSubscription(@CurrentUser() user: JwtPayload) {
    return this.telegramLoggerService.trackAction(
      'Cancel Subscription (/subscription/cancel)',
      user,
      async (logMessage) => {
        const subscription =
          await this.subscriptionService.getCurrentSubscriptionForUser(user.id);
        if (!subscription?.is_active) {
          throw new NotFoundException('Subscription not found');
        }

        await this.telegramLoggerService.appendToMessage(
          logMessage,
          `Subscription ID: <b>#SUB${subscription.payhere_sub_id}</b>`,
        );
        await this.subscriptionService.cancelPayHereSubscription(
          subscription.payhere_sub_id,
        );

        this.logger.log(
          `Subscription ${subscription.payhere_sub_id} cancelled for user ${user.id}`,
        );
        return { message: 'Subscription cancelled successfully' };
      },
    );
  }
}
