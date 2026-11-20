import { Module } from '@nestjs/common';
import { AdminAdminsModule } from './admins/admin-admins.module';
import { AdminAnalyticsModule } from './analytics/admin-analytics.module';
import { AdminAuthModule } from './auth/admin-auth.module';
import { AdminBankReviewsModule } from './bank-reviews/admin-bank-reviews.module';
import { AdminMembersModule } from './members/admin-members.module';
import { AdminTransactionsModule } from './transactions/admin-transactions.module';

/**
 * Everything behind the admin dashboard (BitcoinDeepa-Admin-FE). Auth is
 * global, so every sub-module can use AdminSessionGuard.
 */
@Module({
  imports: [
    AdminAuthModule,
    AdminAnalyticsModule,
    AdminTransactionsModule,
    AdminMembersModule,
    AdminBankReviewsModule,
    AdminAdminsModule,
  ],
})
export class AdminModule {}
