import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { KnexModule } from '../knex/knex.module';
import { BitcoinDeepaModule } from '../bitcoindeepa/bitcoindeepa.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';

@Module({
  imports: [KnexModule, BitcoinDeepaModule, TelegramLoggerModule],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
