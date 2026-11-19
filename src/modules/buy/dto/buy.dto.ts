import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class BuyLinkDto {
  /** Whole rupees. Min/max/daily limits are checked by the service. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amount_lkr!: number;
}
