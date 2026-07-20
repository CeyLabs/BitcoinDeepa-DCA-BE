import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.string('last_name').nullable().alter();
    table.string('address').nullable().alter();
    table.string('city').nullable().alter();
    table.string('country').nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.string('last_name').notNullable().alter();
    table.string('address').notNullable().alter();
    table.string('city').notNullable().alter();
    table.string('country').notNullable().alter();
  });
}
