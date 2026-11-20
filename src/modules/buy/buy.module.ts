import { Module } from '@nestjs/common';
import { KnexModule } from '../knex/knex.module';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';
import { PayHereModule } from '../payhere/payhere.module';
import { BitcoinPriceModule } from '../bitcoin-price/bitcoin-price.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { BuyService } from './buy.service';
import { BuyController } from './buy.controller';

/**
 * One-time buys. Payment notifications, pricing and settlement are shared
 * with subscriptions (transaction + settlement modules, kind = ONE_TIME).
 */
@Module({
  imports: [
    KnexModule,
    AuthModule,
    UserModule,
    PayHereModule,
    BitcoinPriceModule,
    TelegramLoggerModule,
  ],
  controllers: [BuyController],
  providers: [BuyService],
})
export class BuyModule {}
