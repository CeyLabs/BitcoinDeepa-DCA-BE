import type { Knex } from 'knex';

// COLLECTING: committed before the bot debit, so a crash mid-debit leaves a
// trace instead of rolling back to QUOTED. REFUNDING: a refund in progress,
// apart from NEEDS_REVIEW (a human must look). alerted_at: a stuck payout is
// reported once.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    "ALTER TYPE enum_sell_status ADD VALUE IF NOT EXISTS 'COLLECTING' AFTER 'QUOTED'",
  );
  await knex.raw(
    "ALTER TYPE enum_sell_status ADD VALUE IF NOT EXISTS 'REFUNDING' AFTER 'COMPLETED'",
  );
  await knex.schema.alterTable('sell_order', (table) => {
    table.timestamp('alerted_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.dropColumn('alerted_at');
  });
  // Postgres can't drop enum values: move any rows off them and keep the type
  await knex('sell_order')
    .whereIn('status', ['COLLECTING', 'REFUNDING'])
    .update({ status: 'NEEDS_REVIEW' });
}
