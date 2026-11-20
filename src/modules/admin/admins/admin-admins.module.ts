import { Module } from '@nestjs/common';
import { KnexModule } from '../../knex/knex.module';
import { AdminAdminsController } from './admin-admins.controller';
import { AdminAdminsService } from './admin-admins.service';

@Module({
  imports: [KnexModule],
  controllers: [AdminAdminsController],
  providers: [AdminAdminsService],
})
export class AdminAdminsModule {}
