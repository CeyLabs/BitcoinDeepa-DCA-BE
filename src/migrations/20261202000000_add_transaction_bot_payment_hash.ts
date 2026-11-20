import type { Knex } from 'knex';

// The payment_hash of the bot transfer that settled a payment (from /send, or
// /send/status once an approved send executed): the same payment_hash as that
// transfer's row in the user's bot history, so /transaction/bot-history can
// tell exactly which row is the purchase's sats. Null on older payments and
// on ones settled by finding the transfer by memo.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.string('bot_payment_hash', 128).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.dropColumn('bot_payment_hash');
  });
}
