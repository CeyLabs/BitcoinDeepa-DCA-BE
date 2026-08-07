import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.boolean('first_timer_reward_claimed').defaultTo(false).notNullable();
  });

  await knex.schema.alterTable('transaction', (table) => {
    table.bigint('bonus_satoshis').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('first_timer_reward_claimed');
  });

  await knex.schema.alterTable('transaction', (table) => {
    table.dropColumn('bonus_satoshis');
  });
}
