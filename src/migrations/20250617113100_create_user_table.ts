import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user', (table) => {
    table.string('id').primary(); // telegram id
    table.string('first_name').notNullable();
    table.string('last_name').notNullable();
    table.string('email');
    table.string('phone');
    table.string('address').notNullable();
    table.string('city').notNullable();
    table.string('country').notNullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('user');
}
