import type { Knex } from 'knex';

const tableName = 'log';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TYPE enum_log_type AS ENUM ('info', 'warn', 'error');
  `);

  await knex.schema.createTable(tableName, (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.text('text').notNullable();
    table.specificType('type', 'enum_log_type').notNullable().defaultTo('info');
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(tableName);
  await knex.raw('DROP TYPE enum_log_type;');
}
