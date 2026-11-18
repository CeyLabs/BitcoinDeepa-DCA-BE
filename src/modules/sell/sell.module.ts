import { Module } from '@nestjs/common';
import { KnexModule } from '../knex/knex.module';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';
import { BitcoinDeepaModule } from '../bitcoindeepa/bitcoindeepa.module';
import { BitcoinPriceModule } from '../bitcoin-price/bitcoin-price.module';
import { CeyPayModule } from '../ceypay/ceypay.module';
import { BankAccountModule } from '../bank-account/bank-account.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { SellService } from './sell.service';
import { SellSettlementService } from './sell-settlement.service';
import { SellController } from './sell.controller';

/** Selling sats for LKR, paid by CeyPay to the user's verified bank account. */
@Module({
  imports: [
    KnexModule,
    AuthModule,
    UserModule,
    BitcoinDeepaModule,
    BitcoinPriceModule,
    CeyPayModule,
    BankAccountModule,
    TelegramLoggerModule,
  ],
  controllers: [SellController],
  providers: [SellService, SellSettlementService],
  exports: [SellService],
})
export class SellModule {}
