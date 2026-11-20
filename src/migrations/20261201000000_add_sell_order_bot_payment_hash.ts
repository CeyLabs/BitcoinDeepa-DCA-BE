import type { Knex } from 'knex';

// The payment_hash of the bot transfer that paid a sale's collect request:
// the same payment_hash as that transfer's row in the user's bot history, so
// /transaction/bot-history can tell exactly which row is the sale's payment.
// Null on orders from before (and on any the bot didn't give a hash for).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.string('bot_payment_hash', 128).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.dropColumn('bot_payment_hash');
  });
}
