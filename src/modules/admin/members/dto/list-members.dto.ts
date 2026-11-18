import { IsIn, IsOptional } from 'class-validator';
import { KycStatus } from '../../../user/enums/kyc-status.enum';
import { PaginationQueryDto, SearchQuery } from '../../common/pagination';

export const SUBSCRIPTION_FILTERS = ['active', 'none'] as const;
export type SubscriptionFilter = (typeof SUBSCRIPTION_FILTERS)[number];

export class ListMembersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(Object.values(KycStatus))
  kyc?: KycStatus;

  /** active = has an active subscription, none = has none */
  @IsOptional()
  @IsIn(SUBSCRIPTION_FILTERS)
  subscription?: SubscriptionFilter;

  /** Telegram id, name, email or phone */
  @SearchQuery()
  q?: string;
}
