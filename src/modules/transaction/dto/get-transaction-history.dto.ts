import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export type TransactionHistorySource = 'plan' | 'bot' | 'all';

export class GetTransactionHistoryDto {
  @IsOptional()
  @IsIn(['plan', 'bot', 'all'])
  type: TransactionHistorySource = 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;
}
