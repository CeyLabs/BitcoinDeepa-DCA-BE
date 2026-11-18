import { IsIn, IsISO8601, IsOptional, Matches } from 'class-validator';
import { PaginationQueryDto, SearchQuery } from '../../common/pagination';

export const TRANSACTION_STATUSES = [
  'SUCCESS',
  'PENDING',
  'CANCELLED',
  'FAILED',
  'CHARGEBACK',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ListTransactionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(TRANSACTION_STATUSES)
  status?: TransactionStatus;

  /** First day to include, YYYY-MM-DD in Sri Lanka time */
  @IsOptional()
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'from must be a real date' })
  from?: string;

  /** Last day to include, YYYY-MM-DD in Sri Lanka time */
  @IsOptional()
  @Matches(DAY, { message: 'to must be YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'to must be a real date' })
  to?: string;

  /** Payment id, member Telegram id or member name */
  @SearchQuery()
  q?: string;
}
