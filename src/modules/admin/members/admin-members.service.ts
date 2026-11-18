import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KnexService } from '../../knex/knex.service';
import type { KycStatus } from '../../user/enums/kyc-status.enum';
import { likeEscape, type Page, toPage } from '../common/pagination';
import type { ListMembersQueryDto } from './dto/list-members.dto';

export interface AdminMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  kycStatus: KycStatus;
  joinedAt: string;
  /** Plan of the newest active subscription, if any */
  activePlan: string | null;
  /** Settled SUCCESS payments: what the member paid and got sats for */
  totalPaidLkr: number;
  satoshis: number;
  /** SUCCESS payments whose sats weren't sent (yet) */
  unsettledLkr: number;
}

type Row = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  kyc_status: KycStatus;
  created_at: Date;
  active_plan: string | null;
  total_paid: string;
  satoshis: string;
  unsettled: string;
};

const hasActiveSubscription = (knex: Knex) =>
  knex('subscription as s')
    .select(knex.raw('1'))
    .whereRaw('s.user_id = u.id')
    .where('s.is_active', true);

@Injectable()
export class AdminMembersService {
  constructor(private readonly knexService: KnexService) {}

  async list(query: ListMembersQueryDto): Promise<Page<AdminMember>> {
    const { page, pageSize, kyc, subscription, q } = query;
    const knex = this.knexService.knex;

    const filtered = knex('user as u').modify((qb: Knex.QueryBuilder) => {
      if (kyc) qb.where('u.kyc_status', kyc);
      if (subscription === 'active') {
        qb.whereExists(hasActiveSubscription(knex));
      } else if (subscription === 'none') {
        qb.whereNotExists(hasActiveSubscription(knex));
      }
      if (q) {
        const like = `%${likeEscape(q)}%`;
        qb.where((w) => {
          void w
            .where('u.id', q)
            .orWhereRaw("concat_ws(' ', u.first_name, u.last_name) ilike ?", [
              like,
            ])
            .orWhereILike('u.email', like)
            .orWhereILike('u.phone', like);
        });
      }
    });

    const [countRow, rows] = await Promise.all([
      filtered.clone().count<{ count: string }[]>('* as count').first(),
      filtered
        .clone()
        .select(
          'u.id',
          'u.first_name',
          'u.last_name',
          'u.email',
          'u.phone',
          'u.city',
          'u.country',
          'u.kyc_status',
          'u.created_at',
          'plan.active_plan',
          'paid.total_paid',
          'paid.satoshis',
          'paid.unsettled',
        )
        // Per-member lookups. Postgres runs them for every row before the
        // offset too (fine at this size); if this gets slow, pick the page's
        // ids in a subquery first and join these onto that.
        .joinRaw(
          `left join lateral (
            select p.name as active_plan
            from subscription s
            join package p on p.id = s.package_id
            where s.user_id = u.id and s.is_active
            order by s.created_at desc
            limit 1
          ) plan on true`,
        )
        .joinRaw(
          `left join lateral (
            select coalesce(sum(t.gross_amount) filter (where t.settled), 0) as total_paid,
                   coalesce(sum(t.satoshis_purchased) filter (where t.settled), 0) as satoshis,
                   coalesce(sum(t.gross_amount) filter (where not t.settled), 0) as unsettled
            from "transaction" t
            join subscription s on s.payhere_sub_id = t.payhere_sub_id
            where s.user_id = u.id and t.status = 'SUCCESS'
          ) paid on true`,
        )
        .orderBy([
          { column: 'u.created_at', order: 'desc' },
          { column: 'u.id', order: 'desc' },
        ])
        .offset((page - 1) * pageSize)
        .limit(pageSize) as Promise<Row[]>,
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      email: row.email,
      phone: row.phone,
      city: row.city,
      country: row.country,
      kycStatus: row.kyc_status,
      joinedAt: new Date(row.created_at).toISOString(),
      activePlan: row.active_plan,
      totalPaidLkr: Number(row.total_paid),
      satoshis: Number(row.satoshis),
      unsettledLkr: Number(row.unsettled),
    }));
    return toPage(items, Number(countRow?.count ?? 0), query);
  }
}
