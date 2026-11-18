import { Module } from '@nestjs/common';
import { AdminAnalyticsModule } from './analytics/admin-analytics.module';
import { AdminAuthModule } from './auth/admin-auth.module';
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
  ],
})
export class AdminModule {}
