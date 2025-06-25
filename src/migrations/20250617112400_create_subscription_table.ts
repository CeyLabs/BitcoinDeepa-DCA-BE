import type { Knex } from 'knex';

const tableName = 'subscription';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(tableName, (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('user_id').notNullable();
    table
      .uuid('package_id')
      .references('id')
      .inTable('package')
      .onDelete('RESTRICT');
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(tableName);
}
