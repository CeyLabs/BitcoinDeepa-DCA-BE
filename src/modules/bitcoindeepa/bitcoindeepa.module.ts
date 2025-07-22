import { Module } from '@nestjs/common';
import { BitcoinDeepaService } from './bitcoindeepa.service';
import { KnexModule } from '../knex/knex.module';

@Module({
  imports: [KnexModule],
  providers: [BitcoinDeepaService],
  exports: [BitcoinDeepaService],
})
export class BitcoinDeepaModule {}
