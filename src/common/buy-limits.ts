import type { Knex } from 'knex';

import { type Money, toMoney } from './money';

/**
 * One-time buy limits, shared by the checkout link (POST /buy/payhere-link)
 * and the webhook, which re-checks them when a payment arrives - a link can
 * be paid after it expired, or paid twice, and PayHere can't stop either.
 */
export const DEFAULT_BUY_MIN_LKR = 100;
export const DEFAULT_BUY_MAX_LKR = 100_000;
export const DEFAULT_BUY_DAILY_MAX_LKR = 250_000;
export const DEFAULT_BUY_ORDER_TTL_MINUTES = 30;
export const DEFAULT_BUY_LINKS_PER_HOUR = 10;
/** A notification this soon after expiry was paid in time (PayHere lag) */
export const BUY_ORDER_EXPIRY_GRACE_MINUTES = 10;

/** Payments that count towards the daily limit (FAILED/CANCELLED moved no money) */
export const COUNTED_BUY_STATUSES = ['PENDING', 'SUCCESS', 'CHARGEBACK'];

const intEnv = (name: string, fallback: number): number =>
  parseInt(process.env[name] || String(fallback), 10);

export const buyLimits = {
  minLkr: () => intEnv('BUY_MIN_LKR', DEFAULT_BUY_MIN_LKR),
  maxLkr: () => intEnv('BUY_MAX_LKR', DEFAULT_BUY_MAX_LKR),
  dailyMaxLkr: () => intEnv('BUY_DAILY_MAX_LKR', DEFAULT_BUY_DAILY_MAX_LKR),
  orderTtlMinutes: () =>
    intEnv('BUY_ORDER_TTL_MINUTES', DEFAULT_BUY_ORDER_TTL_MINUTES),
  linksPerHour: () => intEnv('BUY_LINKS_PER_HOUR', DEFAULT_BUY_LINKS_PER_HOUR),
};

/** LKR of the user's one-time payments in the last 24h (PayHere told us of). */
export async function paidOneTimeLkr(
  db: Knex | Knex.Transaction,
  userId: string,
): Promise<Money> {
  const row = await db('transaction')
    .where('user_id', userId)
    .where('kind', 'ONE_TIME')
    .whereIn('status', COUNTED_BUY_STATUSES)
    .where('created_at', '>', db.raw("now() - interval '24 hours'"))
    .sum<{ total: string | null }>('gross_amount as total')
    .first();
  return toMoney(row?.total); // SUM(decimal) comes back as a string
}

/**
 * LKR of the user's one-time checkouts that can still be paid and haven't
 * been: reserved against the daily limit until they expire, so opening many
 * links at once can't get past it.
 */
export async function reservedOneTimeLkr(
  db: Knex | Knex.Transaction,
  userId: string,
): Promise<Money> {
  const row = await db('buy_order as o')
    .where('o.user_id', userId)
    .where('o.kind', 'ONE_TIME')
    .where('o.expires_at', '>', db.raw('now()'))
    .whereNotExists((q) => {
      void q
        .select(db.raw('1'))
        .from('transaction as t')
        .whereRaw('t.payhere_order_id = o.order_id')
        .whereIn('t.status', COUNTED_BUY_STATUSES);
    })
    .sum<{ total: string | null }>('o.amount as total')
    .first();
  return toMoney(row?.total);
}
