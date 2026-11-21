import { toApiNumber } from '../../../common/money';
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
  /** SUCCESS payments whose sats were not sent (yet): awaiting settlement,
   *  never confirmed by PayHere, or stopped after the last attempt */
  unsettled: { count: number; grossLkr: number; satoshis: number };
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD (Asia/Colombo)
  /** Settled SUCCESS payments */
  grossLkr: number;
  payments: number;
  /** SUCCESS payments not settled */
  unsettledGrossLkr: number;
  newUsers: number;
}

/** A COUNT(*) */
const num = (value: unknown): number => Number(value ?? 0);
/** A SUM of a money/sats column: summed in SQL (numeric), serialized here */
const amount = (value: unknown): number =>
  toApiNumber(value as string | number | null);

/**
 * Read-only aggregates for the admin dashboard. "Collected" means SETTLED
 * SUCCESS payments (the member got their sats). SUCCESS payments not settled
 * (awaiting payout, never confirmed by PayHere, stopped) are reported apart,
 * so a forged or stuck payment never inflates revenue. Chargebacks, pending
 * and failed payments are excluded.
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
          count(*) filter (where settled) as successful,
          coalesce(sum(gross_amount) filter (where settled), 0) as gross,
          coalesce(sum(net_amount) filter (where settled), 0) as net,
          coalesce(sum(bitcoindeepa_fee_amount) filter (where settled), 0) as bitcoindeepa_fees,
          coalesce(sum(satoshis_purchased) filter (where settled), 0) as satoshis,
          coalesce(sum(gross_amount) filter (where settled and created_at >= now() - interval '30 days'), 0) as gross_30d,
          count(*) filter (where not settled) as unsettled,
          coalesce(sum(gross_amount) filter (where not settled), 0) as unsettled_gross,
          coalesce(sum(satoshis_purchased) filter (where not settled), 0) as unsettled_satoshis
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
        grossLkr: amount(r.gross),
        netLkr: amount(r.net),
        bitcoindeepaFeesLkr: amount(r.bitcoindeepa_fees),
        satoshis: amount(r.satoshis),
        grossLkrLast30Days: amount(r.gross_30d),
      },
      unsettled: {
        count: num(r.unsettled),
        grossLkr: amount(r.unsettled_gross),
        satoshis: amount(r.unsettled_satoshis),
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
        unsettled_gross: string;
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
               coalesce(sum(gross_amount) filter (where settled), 0) as gross,
               count(*) filter (where settled) as payments,
               coalesce(sum(gross_amount) filter (where not settled), 0) as unsettled_gross
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
             coalesce(p.unsettled_gross, 0) as unsettled_gross,
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
      grossLkr: amount(row.gross),
      payments: num(row.payments),
      unsettledGrossLkr: amount(row.unsettled_gross),
      newUsers: num(row.new_users),
    }));
  }
}
