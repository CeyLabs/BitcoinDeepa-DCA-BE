import { IsUUID } from 'class-validator';

export class PayHereLinkDto {
  // 'loose' = any 8-4-4-4-12 hex id (what Postgres' uuid type accepts).
  // Production package ids are 00000000-0000-0000-0000-00000000000N, which the
  // default/'all' modes reject because they lack an RFC version digit.
  @IsUUID('loose')
  package_id: string;
}
