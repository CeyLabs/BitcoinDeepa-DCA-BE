import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  STATEMENT_CONTENT_TYPES,
  STATEMENT_MAX_BYTES,
  type StatementContentType,
} from '../bank-account.constants';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class StatementUploadDto {
  @IsIn(Object.keys(STATEMENT_CONTENT_TYPES))
  contentType!: StatementContentType;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(STATEMENT_MAX_BYTES)
  size!: number;
}

export class AddBankAccountDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  bankCode!: number;

  // Spaces and dashes are allowed when typing; stored as digits only
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  )
  @IsString()
  @Matches(/^\d{6,20}$/, { message: 'accountNumber must be 6-20 digits' })
  accountNumber!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  accountName!: string;

  /** Key returned by POST /bank-accounts/statement-upload */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  statementKey!: string;
}
