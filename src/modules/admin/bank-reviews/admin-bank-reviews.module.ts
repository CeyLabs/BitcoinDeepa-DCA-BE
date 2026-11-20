import { Module } from '@nestjs/common';
import { KnexModule } from '../../knex/knex.module';
import { BankAccountModule } from '../../bank-account/bank-account.module';
import { AdminBankReviewsController } from './admin-bank-reviews.controller';
import { AdminBankReviewsService } from './admin-bank-reviews.service';

@Module({
  imports: [KnexModule, BankAccountModule],
  controllers: [AdminBankReviewsController],
  providers: [AdminBankReviewsService],
})
export class AdminBankReviewsModule {}
