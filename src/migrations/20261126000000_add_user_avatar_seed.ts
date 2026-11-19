import type { Knex } from 'knex';

// The user's profile picture: the seed of a DiceBear "Sprouts" avatar the app
// draws (nothing else is stored). Null: the app draws it from the Telegram id.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.string('avatar_seed', 64).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('avatar_seed');
  });
}
