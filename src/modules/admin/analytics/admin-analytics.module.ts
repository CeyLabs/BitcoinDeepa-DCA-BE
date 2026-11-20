import { Module } from '@nestjs/common';
import { KnexModule } from '../../knex/knex.module';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';

// AdminSessionGuard comes from the global AdminAuthModule
@Module({
  imports: [KnexModule],
  controllers: [AdminAnalyticsController],
  providers: [AdminAnalyticsService],
})
export class AdminAnalyticsModule {}
