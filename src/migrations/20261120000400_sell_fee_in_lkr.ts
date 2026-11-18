import type { Knex } from 'knex';

// The sell fee is now taken in LKR, not sats: the whole sale is priced
// (gross_lkr), the fee comes off that (fee_lkr), and amount_lkr is what the
// user gets. Existing rows are converted from their own rate.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.decimal('gross_lkr', 18, 2).nullable();
    table.decimal('fee_lkr', 18, 2).nullable();
  });
  await knex.raw(`
    UPDATE sell_order
       SET gross_lkr = FLOOR(sats::numeric / 100000000 * btc_lkr_buying_rate * 100) / 100,
           fee_lkr = GREATEST(
             FLOOR(sats::numeric / 100000000 * btc_lkr_buying_rate * 100) / 100 - amount_lkr,
             0)
  `);
  await knex.schema.alterTable('sell_order', (table) => {
    table.decimal('gross_lkr', 18, 2).notNullable().alter();
    table.decimal('fee_lkr', 18, 2).notNullable().alter();
    table.dropColumn('fee_sats');
    table.dropColumn('net_sats');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.bigInteger('fee_sats').nullable();
    table.bigInteger('net_sats').nullable();
  });
  await knex.raw(`
    UPDATE sell_order
       SET fee_sats = CEIL(sats::numeric * fee_basis_points / 10000),
           net_sats = sats - CEIL(sats::numeric * fee_basis_points / 10000)
  `);
  await knex.schema.alterTable('sell_order', (table) => {
    table.bigInteger('fee_sats').notNullable().alter();
    table.bigInteger('net_sats').notNullable().alter();
    table.dropColumn('gross_lkr');
    table.dropColumn('fee_lkr');
  });
}
