import type { Knex } from 'knex';

// The memo a payment's sats are sent with. The memo is the BitcoinDeepa bot's
// idempotency key, and its format changed in this release (`<package> DCA plan
// (Ref: <id>)` → `DCA purchase (Ref: <id>)`), so each payment keeps the memo
// it was first given: set when the row is created. Null = created by an
// earlier release (or by the previous release while this one rolls out); those
// keep the old format, so a retry of a send the old release already made is
// still recognised by the bot instead of paying twice.
//
// Additive and nullable: the previous release ignores it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.text('transfer_memo').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.dropColumn('transfer_memo');
  });
}
