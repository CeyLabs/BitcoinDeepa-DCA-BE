import { Module } from '@nestjs/common';
import { KnexModule } from '../../knex/knex.module';
import { AdminTransactionsController } from './admin-transactions.controller';
import { AdminTransactionsService } from './admin-transactions.service';

// AdminSessionGuard comes from the global AdminAuthModule
@Module({
  imports: [KnexModule],
  controllers: [AdminTransactionsController],
  providers: [AdminTransactionsService],
})
export class AdminTransactionsModule {}
