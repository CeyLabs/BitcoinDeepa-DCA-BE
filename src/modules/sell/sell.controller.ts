import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { KycVerifiedGuard } from '../auth/kyc-verified.guard';
import { RequireKyc } from '../auth/require-kyc.decorator';
import { CurrentUser } from '../auth/user.decorator';
import type { JwtPayload } from '../auth/auth.service';
import { CeyPayService } from '../ceypay/ceypay.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { SellService } from './sell.service';
import { BankVerifiedGuard } from '../bank-account/guards/bank-verified.guard';
import { SellQuoteDto } from './dto/sell.dto';
import {
  CEYPAY_WEBHOOK_EVENTS,
  CeyPayWebhookDto,
} from './dto/ceypay-webhook.dto';
import { SellEnabledGuard } from '../../common/sell-enabled';
import { P2pEnabledGuard } from '../../common/p2p-enabled';

@Controller('sell')
export class SellController {
  private readonly logger = new Logger(SellController.name);

  constructor(
    private readonly sellService: SellService,
    private readonly ceyPay: CeyPayService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  // ---- Selling ---------------------------------------------------------

  @Get('price')
  @UseGuards(SellEnabledGuard, ConditionalAuthGuard)
  getPrice() {
    return this.sellService.getPrice();
  }

  @Post('quote')
  @UseGuards(
    SellEnabledGuard,
    ConditionalAuthGuard,
    KycVerifiedGuard,
    BankVerifiedGuard,
  )
  @RequireKyc()
  quote(@CurrentUser() user: JwtPayload, @Body() body: SellQuoteDto) {
    return this.sellService.quote(user.id, body.sats);
  }

  @Post('orders/:id/confirm')
  @UseGuards(
    SellEnabledGuard,
    ConditionalAuthGuard,
    KycVerifiedGuard,
    BankVerifiedGuard,
  )
  @RequireKyc()
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.telegramLogger.trackAction(
      'Sell sats (/sell/orders/:id/confirm)',
      user,
      () => this.sellService.confirm(user.id, id),
    );
  }

  /**
   * Pay a confirmed sale from the app with the user's Telegram credential
   * (Mini App: X-Telegram-Init-Data; web: the saved login). The bot chat's
   * Pay button does the same without this.
   */
  @Post('orders/:id/pay')
  @UseGuards(P2pEnabledGuard, ConditionalAuthGuard)
  @HttpCode(HttpStatus.OK)
  pay(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-telegram-init-data') initData: string | undefined,
  ) {
    return this.sellService.payInApp(user.id, id, initData);
  }

  /** Withdraw a sale the user hasn't paid yet */
  @Post('orders/:id/cancel')
  @UseGuards(ConditionalAuthGuard)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.sellService.cancel(user.id, id);
  }

  @Get('orders')
  @UseGuards(ConditionalAuthGuard)
  listOrders(@CurrentUser() user: JwtPayload) {
    return this.sellService.listOrders(user.id);
  }

  @Get('orders/:id')
  @UseGuards(ConditionalAuthGuard)
  getOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.sellService.getOrder(user.id, id);
  }

  // ---- CeyPay webhook (public, ED25519-signed) -------------------------

  @Post('ceypay-webhook')
  @HttpCode(HttpStatus.OK)
  async ceypayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: CeyPayWebhookDto,
    @Headers('x-webhook-timestamp') timestamp: string | undefined,
    @Headers('x-webhook-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (
      !this.ceyPay.verifyWebhookSignature(req.rawBody, timestamp, signature)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!(CEYPAY_WEBHOOK_EVENTS as readonly string[]).includes(body.event)) {
      this.logger.log(`Ignoring CeyPay event ${body.event}`);
      return { received: true };
    }

    const applied = await this.sellService.applyOfframp(body.externalRef, {
      paymentId: body.paymentId,
      status: body.event === 'payment.completed' ? 'COMPLETED' : 'FAILED',
      bankRef: body.bankRef ?? null,
      failureReason: body.failureReason ?? null,
    });
    if (!applied) {
      // Duplicate / late / unknown: acknowledge so CeyPay stops retrying
      this.logger.warn(
        `CeyPay ${body.event} for ${body.externalRef} (payment ${body.paymentId}) not applied`,
      );
    }
    return { received: true };
  }
}
