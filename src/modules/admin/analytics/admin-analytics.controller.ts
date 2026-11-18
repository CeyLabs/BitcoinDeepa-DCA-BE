import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../auth/admin-session.guard';
import { AdminAnalyticsService } from './admin-analytics.service';
import { DailyAnalyticsQueryDto } from './dto/analytics-query.dto';

@Controller('admin/analytics')
@UseGuards(AdminSessionGuard)
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @Get('summary')
  summary() {
    return this.analytics.summary();
  }

  @Get('daily')
  daily(@Query() { days }: DailyAnalyticsQueryDto) {
    return this.analytics.daily(days);
  }
}
