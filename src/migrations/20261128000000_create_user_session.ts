import type { Knex } from 'knex';

// Server-side sessions for the user app (replaces the 7-day stateless JWT).
// Only SHA-256(token) is stored. kind: 'web' (Log In with Telegram, cookie)
// or 'miniapp' (initData exchanged at launch, Bearer). A session is valid
// while not revoked and before both idle_expires_at and absolute_expires_at.
//
// telegram_login_attempt: one row per web login in progress (state + PKCE
// verifier), deleted when the callback uses it; expires after 10 minutes.
//
// user.telegram_sub: the OIDC `sub` of a web login. Nullable (Mini App only
// users never get one), unique when set. Accounts link on user.id (the
// Telegram ID), never on sub.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_session', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .string('user_id')
      .notNullable()
      .references('id')
      .inTable('user')
      .onDelete('CASCADE');
    table.binary('token_hash').notNullable().unique();
    table.string('kind', 16).notNullable();
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp('last_seen_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.timestamp('idle_expires_at', { useTz: true }).notNullable();
    table.timestamp('absolute_expires_at', { useTz: true }).notNullable();
    table.timestamp('revoked_at', { useTz: true }).nullable();
    table.string('user_agent', 512).nullable();
    table.string('ip', 64).nullable();
    table.index(['user_id']);
    table.index(['idle_expires_at']);
  });
  await knex.raw(
    `ALTER TABLE user_session ADD CONSTRAINT user_session_kind CHECK (kind IN ('web', 'miniapp'))`,
  );

  await knex.schema.createTable('telegram_login_attempt', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.binary('state_hash').notNullable();
    table.string('code_verifier', 128).notNullable();
    table.string('return_to', 512).notNullable();
    table.string('referral_code', 64).nullable();
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.index(['expires_at']);
  });

  await knex.schema.alterTable('user', (table) => {
    table.text('telegram_sub').nullable().unique();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('telegram_sub');
  });
  await knex.schema.dropTableIfExists('telegram_login_attempt');
  await knex.schema.dropTableIfExists('user_session');
}
