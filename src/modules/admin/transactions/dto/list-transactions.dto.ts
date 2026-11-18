import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export const TRANSACTION_STATUSES = [
  'SUCCESS',
  'PENDING',
  'CANCELLED',
  'FAILED',
  'CHARGEBACK',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const PAGE_SIZES = [10, 20, 50, 100] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ListTransactionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsIn(PAGE_SIZES)
  pageSize: number = 20;

  @IsOptional()
  @IsIn(TRANSACTION_STATUSES)
  status?: TransactionStatus;

  /** First day to include, YYYY-MM-DD in Sri Lanka time */
  @IsOptional()
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  /** Last day to include, YYYY-MM-DD in Sri Lanka time */
  @IsOptional()
  @Matches(DAY, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  /** Payment id, member Telegram id or member name */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  q?: string;
}
