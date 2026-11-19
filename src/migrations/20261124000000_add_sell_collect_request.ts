import type { Knex } from 'knex';

// Sell debits go through the bot's collect API: confirm asks the user to pay
// and the order stays COLLECTING until they do.
// - bot_collect_id: the bot's request id (col-...)
// - collect_expires_at: when we withdraw an unanswered request (the quote's
//   price is only held this long)
// - collect_state: the request's last seen state, for the app
// All nullable, no backfill.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.string('bot_collect_id').nullable();
    table.timestamp('collect_expires_at').nullable();
    table.string('collect_state').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sell_order', (table) => {
    table.dropColumn('collect_state');
    table.dropColumn('collect_expires_at');
    table.dropColumn('bot_collect_id');
  });
}
