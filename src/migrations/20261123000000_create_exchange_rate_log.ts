import type { Knex } from 'knex';

// One row a minute with the BTC/LKR rate and the two rates it is made of
// (Ceylon Cash BTC/USD × CeyPay USDT/LKR). When a live price can't be fetched,
// buys and DCA payments are priced from the latest recent row instead of
// waiting for the backfill cron. Exactly one row is_active: the current rate.
// Recording a new rate deactivates the previous one; setting is_active = false
// by hand takes a bad rate out of use. A new table, nothing else reads it, so
// the previous release is unaffected.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('exchange_rate_log', (table) => {
    table.bigIncrements('id').primary();
    table.decimal('btc_usd', 20, 8).notNullable();
    table.decimal('usdt_lkr', 20, 8).notNullable();
    // LKR per BTC, rounded down to cents (what the app prices with)
    table.decimal('btc_lkr', 20, 2).notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });
  // At most one active row, and the lookup for it
  await knex.raw(
    'CREATE UNIQUE INDEX idx_exchange_rate_log_active ON exchange_rate_log (is_active) WHERE is_active',
  );
  await knex.raw(
    'CREATE INDEX idx_exchange_rate_log_created_at ON exchange_rate_log (created_at DESC)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('exchange_rate_log');
}
