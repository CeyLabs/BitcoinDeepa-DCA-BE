import {
  Controller,
  Post,
  Res,
  HttpStatus,
  HttpException,
  Get,
  UseGuards,
  Body,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { Response } from 'express';
import { TransactionService } from './transaction.service';
import { PayHereNotificationDto } from './dto/payhere-notification.dto';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { AdminKeyGuard } from '../auth/admin-key.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { BitcoinDeepaService } from '../bitcoindeepa/bitcoindeepa.service';

/** Parse a positive integer query param, clamped to [min, max]. */
function parseIntParam(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value === undefined ? NaN : parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

@Controller('transaction')
export class TransactionController {
  constructor(
    private readonly transactionService: TransactionService,
    private readonly dbLogger: DatabaseLoggerService,
    private readonly telegramLoggerService: TelegramLoggerService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
  ) {}

  @Post('payhere-webhook')
  async handlePayHereWebhook(
    @Body() body: PayHereNotificationDto,
    @Res() res: Response,
  ) {
    await this.dbLogger.info(
      `PayHere webhook received: order_id=${body.order_id}, status=${body.status_code}, amount=${body.payhere_amount} ${body.payhere_currency}`,
    );

    // Reject forged requests before touching Telegram or the DB
    if (!this.transactionService.isValidPayHereSignature(body)) {
      await this.dbLogger.warn(
        `PayHere webhook rejected (bad signature) for order_id ${body.order_id}`,
      );
      return res.status(HttpStatus.UNAUTHORIZED).send();
    }

    try {
      const logMessage = await this.telegramLoggerService.logNewTransaction(
        body.payment_id,
        body.payhere_amount,
        body.custom_1 ?? 'unknown',
        this.transactionService.getPayHereStatusMapped(body.status_code),
      );

      await this.transactionService.handlePayHereNotification(body);

      await this.telegramLoggerService.setMessageReaction(logMessage);
      return res.status(HttpStatus.OK).send('OK');
    } catch (error) {
      await this.dbLogger.error(
        `PayHere webhook processing failed for order_id ${body.order_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const status =
        error instanceof HttpException
          ? error.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
      return res.status(status).send();
    }
  }

  @Post('reset-retry-counts')
  @UseGuards(AdminKeyGuard)
  async resetRetryCounts() {
    return this.transactionService.resetRetryCounts();
  }

  @Get('list')
  @UseGuards(ConditionalAuthGuard)
  async getUserTransactions(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = parseIntParam(page, 1, 1, 10_000);
    const limitNum = parseIntParam(limit, 10, 1, 100);

    const logMessage = await this.telegramLoggerService.logGenericAction(
      'Transaction List (/transaction/list)',
      user,
    );

    const result =
      await this.transactionService.getTransactionsByUserIdPaginated(
        user.id,
        pageNum,
        limitNum,
      );

    await this.telegramLoggerService.setMessageReaction(logMessage);
    return result;
  }

  @Get('latest')
  @UseGuards(ConditionalAuthGuard)
  async getLatestTransaction(@CurrentUser() user: JwtPayload) {
    const transaction =
      await this.transactionService.getLatestTransactionForUser(user.id);

    if (!transaction) {
      throw new NotFoundException('No transactions found');
    }
    return transaction;
  }

  @Get('bot-history')
  @UseGuards(ConditionalAuthGuard)
  async getBotTransactionHistory(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = parseIntParam(limit, 100, 1, 250);
    const offsetNum = parseIntParam(offset, 0, 0, Number.MAX_SAFE_INTEGER);

    return this.bitcoinDeepaService.getUserTransactions(
      Number(user.id),
      limitNum,
      offsetNum,
    );
  }

  @Get('dca-summary')
  @UseGuards(ConditionalAuthGuard)
  async getDCASummary(@CurrentUser() user: JwtPayload) {
    const logMessage = await this.telegramLoggerService.logGenericAction(
      'Main balance (/transaction/dca-summary)',
      user,
    );

    const summary = await this.transactionService.getDCASummaryForUser(user.id);

    await this.telegramLoggerService.setMessageReaction(logMessage);
    return summary;
  }
}
