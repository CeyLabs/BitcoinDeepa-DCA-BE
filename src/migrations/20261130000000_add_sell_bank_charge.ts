import type { Knex } from 'knex';

// A flat bank charge (LKR) taken off each sale, after the % fee.
// Existing orders weren't charged one, so they get 0.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.decimal('bank_charge_lkr', 18, 2).notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.dropColumn('bank_charge_lkr');
  });
}
