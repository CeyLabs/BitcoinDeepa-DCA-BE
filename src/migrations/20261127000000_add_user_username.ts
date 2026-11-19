import type { Knex } from 'knex';

// The member's own Bitcoin Deepa @username (not their Telegram username):
// how others find them to send sats. Optional, claimed once, never changed.
// Stored lower-case (the app and API normalize), so the plain unique index
// is case-insensitive in effect; the CHECK keeps rows to the same rule as
// USERNAME_PATTERN in src/modules/user/username.ts.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.string('username', 20).nullable().unique();
  });
  await knex.raw(
    `ALTER TABLE "user" ADD CONSTRAINT user_username_format CHECK (username ~ '^[a-z][a-z0-9_]{2,19}$')`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_username_format',
  );
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('username');
  });
}
