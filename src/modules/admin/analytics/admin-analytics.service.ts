import { Injectable } from '@nestjs/common';
import { KnexService } from '../../knex/knex.service';

/** Days are bucketed in Sri Lanka time. */
const TZ = 'Asia/Colombo';

export interface AnalyticsSummary {
  users: { total: number; kycApproved: number; newLast30Days: number };
  subscriptions: { active: number; total: number };
  payments: {
    successful: number;
    grossLkr: number;
    netLkr: number;
    bitcoindeepaFeesLkr: number;
    satoshis: number;
    grossLkrLast30Days: number;
  };
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD (Asia/Colombo)
  grossLkr: number;
  payments: number;
  newUsers: number;
}

const num = (value: unknown): number => Number(value ?? 0);

/**
 * Read-only aggregates for the admin dashboard. "Collected" means SUCCESS
 * payments only (chargebacks, pending and failed are excluded).
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly knexService: KnexService) {}

  private get knex() {
    return this.knexService.knex;
  }

  async summary(): Promise<AnalyticsSummary> {
    const { rows } = await this.knex.raw<{
      rows: Record<string, string | null>[];
    }>(`
      select
        (select count(*) from "user") as users_total,
        (select count(*) from "user" where kyc_status = 'APPROVED') as users_kyc_approved,
        (select count(*) from "user" where created_at >= now() - interval '30 days') as users_new_30d,
        (select count(*) from subscription where is_active) as subs_active,
        (select count(*) from subscription) as subs_total,
        p.*
      from (
        select
          count(*) as successful,
          coalesce(sum(gross_amount), 0) as gross,
          coalesce(sum(net_amount), 0) as net,
          coalesce(sum(bitcoindeepa_fee_amount), 0) as bitcoindeepa_fees,
          coalesce(sum(satoshis_purchased), 0) as satoshis,
          coalesce(sum(gross_amount) filter (where created_at >= now() - interval '30 days'), 0) as gross_30d
        from "transaction"
        where status = 'SUCCESS'
      ) p
    `);
    const r = rows[0];

    return {
      users: {
        total: num(r.users_total),
        kycApproved: num(r.users_kyc_approved),
        newLast30Days: num(r.users_new_30d),
      },
      subscriptions: {
        active: num(r.subs_active),
        total: num(r.subs_total),
      },
      payments: {
        successful: num(r.successful),
        grossLkr: num(r.gross),
        netLkr: num(r.net),
        bitcoindeepaFeesLkr: num(r.bitcoindeepa_fees),
        satoshis: num(r.satoshis),
        grossLkrLast30Days: num(r.gross_30d),
      },
    };
  }

  /** One row per day (zero-filled) for the last `days` days, today included. */
  async daily(days: number): Promise<DailyPoint[]> {
    const { rows } = await this.knex.raw<{
      rows: {
        date: string;
        gross: string;
        payments: string;
        new_users: string;
      }[];
    }>(
      `
      with days as (
        select generate_series(
          (now() at time zone :tz)::date - (:days::int - 1),
          (now() at time zone :tz)::date,
          interval '1 day'
        )::date as date
      ),
      payments as (
        select (created_at at time zone :tz)::date as date,
               sum(gross_amount) as gross,
               count(*) as payments
        from "transaction"
        where status = 'SUCCESS'
          and created_at >= now() - make_interval(days => :days::int + 1)
        group by 1
      ),
      users as (
        select (created_at at time zone :tz)::date as date, count(*) as new_users
        from "user"
        where created_at >= now() - make_interval(days => :days::int + 1)
        group by 1
      )
      select to_char(d.date, 'YYYY-MM-DD') as date,
             coalesce(p.gross, 0) as gross,
             coalesce(p.payments, 0) as payments,
             coalesce(u.new_users, 0) as new_users
      from days d
      left join payments p using (date)
      left join users u using (date)
      order by d.date
      `,
      { tz: TZ, days },
    );

    return rows.map((row) => ({
      date: row.date,
      grossLkr: num(row.gross),
      payments: num(row.payments),
      newUsers: num(row.new_users),
    }));
  }
}
