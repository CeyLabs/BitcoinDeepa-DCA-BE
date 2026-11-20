import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const PAGE_SIZES = [10, 20, 50, 100] as const;

/** ?page=&pageSize= shared by the admin list endpoints. */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsIn(PAGE_SIZES)
  pageSize: number = 20;
}

/** Optional trimmed search text; blank means no search. */
export function SearchQuery(): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    IsString()(target, key);
    MaxLength(100)(target, key);
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() || undefined : value,
    )(target, key);
  };
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function toPage<T>(
  items: T[],
  total: number,
  { page, pageSize }: PaginationQueryDto,
): Page<T> {
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Escape LIKE wildcards so a search for "100%" matches literally. */
export const likeEscape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
