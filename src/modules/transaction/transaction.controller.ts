import {
  Controller,
  Post,
  Res,
  HttpStatus,
  Get,
  UseGuards,
  Body,
} from '@nestjs/common';
import { Response } from 'express';
import {
  PayHereNotificationParams,
  TransactionService,
} from './transaction.service';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';

@Controller('webhook')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Post('payhere')
  async handlePayHereWebhook(
    @Body() body: PayHereNotificationParams,
    @Res() res: Response,
  ) {
    // req.body will contain the form-urlencoded data
    await this.transactionService.handlePayHereNotification(body);
    return res.status(HttpStatus.OK).send('OK');
  }

  @Get('current')
  @UseGuards(ConditionalAuthGuard)
  async getUserTransactions(@CurrentUser() user: JwtPayload) {
    return this.transactionService.getTransactionsByUserId(user.user_id);
  }
}
