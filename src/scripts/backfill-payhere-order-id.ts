/**
 * One-off: bind subscriptions created before order binding to their PayHere
 * checkout order_id, read from PayHere's own payment list (every charge of a
 * subscription carries its order_id). Once every row is bound, the lazy
 * "first notification binds it" branch in resolveSubscription never runs.
 *
 *   bun run backfill:payhere-orders            # dry run: prints what it would do
 *   bun run backfill:payhere-orders --execute  # writes
 *
 * Uses the DB from .env / NODE_ENV and the PayHere OAuth app
 * (PAYHERE_APP_ID / PAYHERE_APP_SECRET / PAYHERE_ENV).
 */
import 'dotenv/config';
import { knex as createKnex, type Knex } from 'knex';
import config from '../../knexfile';
import { PayHereService } from '../modules/payhere/payhere.service';

// PayHere's merchant API allows 20 requests per 10 s
const DELAY_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  payhere_sub_id: string;
  user_id: string;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const env = process.env.NODE_ENV || 'development';
  const db: Knex = createKnex((config as Record<string, Knex.Config>)[env]);
  const payhere = new PayHereService();
  const counts = { bound: 0, skipped: 0, failed: 0 };

  try {
    const rows = await db<Row>('subscription')
      .select('payhere_sub_id', 'user_id')
      .whereNull('payhere_order_id')
      .orderBy('created_at');
    console.log(
      `${rows.length} subscription(s) without an order_id (${execute ? 'EXECUTE' : 'dry run'}, ${env})`,
    );

    for (const row of rows) {
      await sleep(DELAY_MS);
      let orderIds: string[];
      try {
        const payments = await payhere.getSubscriptionPayments(
          row.payhere_sub_id,
        );
        orderIds = [
          ...new Set(payments.map((p) => p.order_id).filter(Boolean)),
        ] as string[];
      } catch (error) {
        counts.failed++;
        console.log(
          `  ${row.payhere_sub_id}: lookup failed: ${(error as Error).message}`,
        );
        continue;
      }

      if (orderIds.length !== 1) {
        counts.skipped++;
        console.log(
          `  ${row.payhere_sub_id}: skipped, PayHere lists ${orderIds.length} order ids (${orderIds.join(', ') || 'none'})`,
        );
        continue;
      }
      const orderId = orderIds[0];

      // Never take an order_id that is bound elsewhere or belongs to someone else
      const taken = await db('subscription')
        .where('payhere_order_id', orderId)
        .first<{ payhere_sub_id: string } | undefined>('payhere_sub_id');
      const order = await db('buy_order')
        .where('order_id', orderId)
        .first<{ user_id: string } | undefined>('user_id');
      if (taken || (order && order.user_id !== row.user_id)) {
        counts.skipped++;
        console.log(
          `  ${row.payhere_sub_id}: skipped, order ${orderId} is ${taken ? `bound to ${taken.payhere_sub_id}` : "another user's order"}`,
        );
        continue;
      }

      console.log(`  ${row.payhere_sub_id}: -> ${orderId}`);
      if (execute) {
        await db('subscription')
          .update({ payhere_order_id: orderId })
          .where('payhere_sub_id', row.payhere_sub_id)
          .whereNull('payhere_order_id');
      }
      counts.bound++;
    }

    console.log(
      `${execute ? 'Bound' : 'Would bind'} ${counts.bound}, skipped ${counts.skipped}, failed ${counts.failed}`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
