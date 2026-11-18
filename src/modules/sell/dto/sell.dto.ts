import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class SellQuoteDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_100_000_000_000_000)
  sats!: number;
}
