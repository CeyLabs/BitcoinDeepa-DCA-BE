import {
  Controller,
  Post,
  Res,
  HttpStatus,
  Get,
  UseGuards,
  Body,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { Response } from 'express';
import {
  PayHereNotificationParams,
  TransactionService,
} from './transaction.service';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';

@Controller('transaction')
export class TransactionController {
  constructor(
    private readonly transactionService: TransactionService,
    private readonly dbLogger: DatabaseLoggerService,
    private readonly telegramLoggerService: TelegramLoggerService,
  ) {}

  @Post('payhere-webhook')
  async handlePayHereWebhook(
    @Body() body: PayHereNotificationParams,
    @Res() res: Response,
  ) {
    await this.dbLogger.info(
      `PayHere webhook received: order_id=${body.order_id}, status=${body.status_code}, amount=${body.payhere_amount} ${body.payhere_currency}`,
    );

    try {
      await this.transactionService.handlePayHereNotification(body);
      await this.dbLogger.info(
        `PayHere webhook processed successfully for order_id: ${body.order_id}`,
      );

      if (body.status_code === '2') {
        await this.telegramLoggerService.logNewTransaction(
          body.payment_id,
          body.payhere_amount,
          body.custom_1!, // user telegram ID
        );
      }

      return res.status(HttpStatus.OK).send('OK');
    } catch (error) {
      await this.dbLogger.error(
        `PayHere webhook processing failed for order_id ${body.order_id}: ${error.message}`,
      );
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
    }
  }

  @Get('list')
  @UseGuards(ConditionalAuthGuard)
  async getUserTransactions(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    const logMessageId = await this.telegramLoggerService.logUserAction(
      'Transaction List (/transaction/list)',
      user,
    );

    await this.dbLogger.info(
      `User ${user.id} requesting transaction history (page: ${pageNum}, limit: ${limitNum})`,
    );

    const result =
      await this.transactionService.getTransactionsByUserIdPaginated(
        user.id,
        pageNum,
        limitNum,
      );

    await this.dbLogger.info(
      `Returned ${result.transactions.length} transactions for user ${user.id} (page ${pageNum}/${result.total_pages})`,
    );
    await this.telegramLoggerService.setMessageReaction(logMessageId);
    return result;
  }

  @Get('latest')
  @UseGuards(ConditionalAuthGuard)
  async getLatestTransaction(@CurrentUser() user: JwtPayload) {
    await this.dbLogger.info(`User ${user.id} requesting latest transaction`);
    const transaction =
      await this.transactionService.getLatestTransactionForUser(user.id);

    if (transaction) {
      await this.dbLogger.info(
        `Latest transaction found for user ${user.id}: ${transaction.payhere_pay_id}, status: ${transaction.status}`,
      );
      return transaction;
    } else {
      await this.dbLogger.warn(
        `No transactions found for user ${user.id} with active subscription`,
      );
      throw new NotFoundException('No transactions found');
    }
  }

  @Get('dca-summary')
  @UseGuards(ConditionalAuthGuard)
  async getDCASummary(@CurrentUser() user: JwtPayload) {
    const logMessageId = await this.telegramLoggerService.logUserAction(
      'Main balance (/transaction/dca-summary)',
      user,
    );

    await this.dbLogger.info(`User ${user.id} requesting DCA summary`);
    const summary = await this.transactionService.getDCASummaryForUser(user.id);

    if (summary) {
      await this.dbLogger.info(
        `DCA summary calculated for user ${user.id}: ${summary.total_satoshis_purchased} sats, ${summary.successful_transactions} transactions`,
      );
    } else {
      await this.dbLogger.info(
        `No DCA summary data available for user ${user.id}`,
      );
    }

    await this.telegramLoggerService.setMessageReaction(logMessageId);
    return summary;
  }
}
