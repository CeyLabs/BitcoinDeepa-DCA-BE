import type { Knex } from 'knex';

const tableName = 'subscription';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(tableName, (table) => {
    table.string('payhere_sub_id').primary();
    table
      .string('user_id')
      .references('id')
      .inTable('user')
      .onDelete('RESTRICT');
    table
      .uuid('package_id')
      .references('id')
      .inTable('package')
      .onDelete('RESTRICT');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(tableName);
}
