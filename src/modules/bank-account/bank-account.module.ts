import { Module } from '@nestjs/common';
import { KnexModule } from '../knex/knex.module';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';
import { DiditModule } from '../didit/didit.module';
import { CeyPayModule } from '../ceypay/ceypay.module';
import { StorageModule } from '../storage/storage.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { BankAccountService } from './bank-account.service';
import { BankAccountController } from './bank-account.controller';
import { BankVerifiedGuard } from './guards/bank-verified.guard';

/**
 * Users' payout bank accounts and their admin verification (statement in R2,
 * reviewed in the admin dashboard, registered with CeyPay on approval).
 */
@Module({
  imports: [
    KnexModule,
    AuthModule,
    UserModule,
    DiditModule,
    CeyPayModule,
    StorageModule,
    TelegramLoggerModule,
  ],
  controllers: [BankAccountController],
  providers: [BankAccountService, BankVerifiedGuard],
  exports: [BankAccountService, BankVerifiedGuard],
})
export class BankAccountModule {}
