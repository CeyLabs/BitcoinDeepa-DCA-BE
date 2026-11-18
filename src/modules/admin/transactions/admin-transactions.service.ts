import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KnexService } from '../../knex/knex.service';
import type {
  ListTransactionsQueryDto,
  TransactionStatus,
} from './dto/list-transactions.dto';

const TZ = 'Asia/Colombo';

export interface AdminTransaction {
  id: string;
  createdAt: string;
  status: TransactionStatus;
  settled: boolean;
  grossLkr: number | null;
  netLkr: number | null;
  satoshis: number | null;
  user: { id: string; name: string } | null;
  packageName: string | null;
}

export interface TransactionPage {
  items: AdminTransaction[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

type Row = {
  payhere_pay_id: string;
  created_at: Date;
  status: TransactionStatus;
  settled: boolean;
  gross_amount: string | null;
  net_amount: string | null;
  satoshis_purchased: string | null;
  user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  package_name: string | null;
};

const toNumber = (value: string | null) =>
  value === null ? null : Number(value);

/** Escape LIKE wildcards so a search for "100%" matches literally. */
const likeEscape = (value: string) => value.replace(/[\\%_]/g, '\\$&');

@Injectable()
export class AdminTransactionsService {
  constructor(private readonly knexService: KnexService) {}

  async list(query: ListTransactionsQueryDto): Promise<TransactionPage> {
    const { page, pageSize, status, from, to, q } = query;
    const knex = this.knexService.knex;

    const filtered = knex('transaction as t')
      .leftJoin('subscription as s', 's.payhere_sub_id', 't.payhere_sub_id')
      .leftJoin('user as u', 'u.id', 's.user_id')
      .leftJoin('package as p', 'p.id', 's.package_id')
      .modify((qb: Knex.QueryBuilder) => {
        if (status) qb.where('t.status', status);
        // Day bounds in Sri Lanka time, written so the created_at index is used
        if (from) {
          qb.where(
            't.created_at',
            '>=',
            knex.raw('(?::date)::timestamp at time zone ?', [from, TZ]),
          );
        }
        if (to) {
          qb.where(
            't.created_at',
            '<',
            knex.raw('(?::date + 1)::timestamp at time zone ?', [to, TZ]),
          );
        }
        if (q) {
          const like = `%${likeEscape(q)}%`;
          qb.where((w) => {
            void w
              .where('t.payhere_pay_id', q)
              .orWhere('u.id', q)
              .orWhereRaw("concat_ws(' ', u.first_name, u.last_name) ilike ?", [
                like,
              ]);
          });
        }
      });

    const [countRow, rows] = await Promise.all([
      filtered.clone().count<{ count: string }[]>('* as count').first(),
      filtered
        .clone()
        .select(
          't.payhere_pay_id',
          't.created_at',
          't.status',
          't.settled',
          't.gross_amount',
          't.net_amount',
          't.satoshis_purchased',
          'u.id as user_id',
          'u.first_name',
          'u.last_name',
          'p.name as package_name',
        )
        .orderBy([
          { column: 't.created_at', order: 'desc' },
          { column: 't.payhere_pay_id', order: 'desc' },
        ])
        .offset((page - 1) * pageSize)
        .limit(pageSize) as Promise<Row[]>,
    ]);

    const total = Number(countRow?.count ?? 0);
    return {
      items: rows.map((row) => ({
        id: row.payhere_pay_id,
        createdAt: new Date(row.created_at).toISOString(),
        status: row.status,
        settled: row.settled,
        grossLkr: toNumber(row.gross_amount),
        netLkr: toNumber(row.net_amount),
        satoshis: toNumber(row.satoshis_purchased),
        user: row.user_id
          ? {
              id: row.user_id,
              name: [row.first_name, row.last_name].filter(Boolean).join(' '),
            }
          : null,
        packageName: row.package_name,
      })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}
