import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { ReviewReminderService } from './review-reminder.service';
import { KnexModule } from '../knex/knex.module';
import { BitcoinDeepaModule } from '../bitcoindeepa/bitcoindeepa.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { PayHereModule } from '../payhere/payhere.module';

@Module({
  imports: [
    KnexModule,
    BitcoinDeepaModule,
    TelegramLoggerModule,
    PayHereModule,
  ],
  providers: [SettlementService, ReviewReminderService],
  exports: [SettlementService],
})
export class SettlementModule {}
