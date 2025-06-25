import type { Knex } from 'knex';

const tableName = 'package';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');

  await knex.schema.createTable(tableName, (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name').notNullable();
    table
      .enum('frequency', ['weekly', 'monthly'], {
        useNative: true,
        enumName: 'enum_frequency',
      })
      .notNullable();
    table.float('amount').notNullable();
    table.string('currency').notNullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists(tableName)
    .raw('DROP TYPE IF EXISTS "enum_frequency";');
}
