import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { BankAccountStatus } from '../../../bank-account/bank-account.constants';
import { PaginationQueryDto, SearchQuery } from '../../common/pagination';

export class ListBankReviewsQueryDto extends PaginationQueryDto {
  /** Defaults to PENDING_REVIEW */
  @IsOptional()
  @IsIn(Object.values(BankAccountStatus))
  status?: BankAccountStatus;

  /** Telegram id, member name, account name or account number */
  @SearchQuery()
  q?: string;
}

export class RejectBankAccountDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
