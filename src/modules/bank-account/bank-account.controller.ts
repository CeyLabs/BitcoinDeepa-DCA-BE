import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { BankAccountService } from './bank-account.service';
import { AddBankAccountDto, StatementUploadDto } from './dto/bank-account.dto';

@Controller('bank-accounts')
@UseGuards(ConditionalAuthGuard)
export class BankAccountController {
  constructor(
    private readonly bankAccounts: BankAccountService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  /** Supported banks (CeyPay list) */
  @Get('banks')
  getBanks() {
    return this.bankAccounts.getBanks();
  }

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.bankAccounts.listForUser(user.id);
  }

  /** Step 1: a temporary presigned PUT URL for the bank statement. */
  @Post('statement-upload')
  @UseGuards(KycVerifiedGuard)
  @RequireKyc()
  createStatementUpload(
    @CurrentUser() user: JwtPayload,
    @Body() body: StatementUploadDto,
  ) {
    return this.bankAccounts.createStatementUpload(user.id, body);
  }

  /** Step 2: submit the account for admin review. */
  @Post()
  @UseGuards(KycVerifiedGuard)
  @RequireKyc()
  add(@CurrentUser() user: JwtPayload, @Body() body: AddBankAccountDto) {
    return this.telegramLogger.trackAction(
      'Add Bank Account (/bank-accounts)',
      user,
      () => this.bankAccounts.submit(user.id, body),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    await this.bankAccounts.remove(user.id, id);
  }
}
