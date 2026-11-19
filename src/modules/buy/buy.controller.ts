import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { KycVerifiedGuard } from '../auth/kyc-verified.guard';
import { RequireKyc } from '../auth/require-kyc.decorator';
import { CurrentUser } from '../auth/user.decorator';
import type { JwtPayload } from '../auth/auth.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { BuyService } from './buy.service';
import { BuyLinkDto } from './dto/buy.dto';

/** One-time BTC buys: a single PayHere checkout for a custom LKR amount. */
@Controller('buy')
export class BuyController {
  constructor(
    private readonly buyService: BuyService,
    private readonly telegramLoggerService: TelegramLoggerService,
  ) {}

  @Get('price')
  @UseGuards(ConditionalAuthGuard)
  getPrice() {
    return this.buyService.getPrice();
  }

  @Post('payhere-link')
  @UseGuards(ConditionalAuthGuard, KycVerifiedGuard)
  @RequireKyc()
  createPayHereLink(@CurrentUser() user: JwtPayload, @Body() body: BuyLinkDto) {
    return this.telegramLoggerService.trackAction(
      `Generate one-time buy link (/buy/payhere-link) ${body.amount_lkr} LKR`,
      user,
      () => this.buyService.createPayHereLink(user.id, body.amount_lkr),
    );
  }

  @Get('orders/:orderId')
  @UseGuards(ConditionalAuthGuard)
  getOrder(
    @CurrentUser() user: JwtPayload,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.buyService.getOrder(user.id, orderId);
  }
}
