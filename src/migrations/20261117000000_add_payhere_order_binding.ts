import type { Knex } from 'knex';

// Bind each subscription to the PayHere order_id it was created with.
// order_id is covered by PayHere's md5sig; subscription_id/payment_id are not.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscription', (table) => {
    table.string('payhere_order_id').nullable().unique();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscription', (table) => {
    table.dropUnique(['payhere_order_id']);
    table.dropColumn('payhere_order_id');
  });
}
