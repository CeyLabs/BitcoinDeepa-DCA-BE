import type { Knex } from 'knex';

// Server-side record of every PayHere checkout we start. The webhook takes
// user_id/package_id from here (keyed by the signed order_id) instead of the
// unsigned custom_1/custom_2 fields, which the payer can edit.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payhere_order', (table) => {
    table.string('order_id').primary();
    table
      .string('user_id')
      .notNullable()
      .references('id')
      .inTable('user')
      .onDelete('RESTRICT');
    table
      .uuid('package_id')
      .notNullable()
      .references('id')
      .inTable('package')
      .onDelete('RESTRICT');
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payhere_order');
}
