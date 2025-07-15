import { Module } from '@nestjs/common';
import { PayHereService } from './payhere.service';
import { KnexModule } from '../knex/knex.module';

@Module({
  imports: [KnexModule],
  providers: [PayHereService],
  exports: [PayHereService],
})
export class PayHereModule {}
