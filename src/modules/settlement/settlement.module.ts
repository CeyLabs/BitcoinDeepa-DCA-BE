import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { KnexModule } from '../knex/knex.module';
import { BitcoinDeepaModule } from '../bitcoindeepa/bitcoindeepa.module';

@Module({
  imports: [KnexModule, BitcoinDeepaModule],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
