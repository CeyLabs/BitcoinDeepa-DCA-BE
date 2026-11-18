import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

export const ANALYTICS_RANGES = [7, 30, 90] as const;

export class DailyAnalyticsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsIn(ANALYTICS_RANGES)
  days: number = 30;
}
