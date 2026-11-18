import type { Knex } from 'knex';

// Better Auth tables for the admin dashboard (see src/modules/admin/auth).
// Prefixed with admin_ so they never collide with the Telegram `user` table.
// Column names are snake_case; the mapping lives in admin-auth.config.ts.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('admin_user', (table) => {
    table.text('id').primary();
    table.text('name').notNullable();
    table.text('email').notNullable().unique();
    table.boolean('email_verified').notNullable().defaultTo(false);
    table.text('image');
    // admin plugin
    table.text('role');
    table.boolean('banned').defaultTo(false);
    table.text('ban_reason');
    table.timestamp('ban_expires', { useTz: true });
    table.timestamps(true, true);
  });

  await knex.schema.createTable('admin_session', (table) => {
    table.text('id').primary();
    table.text('token').notNullable().unique();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.text('ip_address');
    table.text('user_agent');
    table
      .text('user_id')
      .notNullable()
      .references('id')
      .inTable('admin_user')
      .onDelete('CASCADE')
      .index();
    // admin plugin
    table.text('impersonated_by');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('admin_account', (table) => {
    table.text('id').primary();
    table.text('account_id').notNullable();
    table.text('provider_id').notNullable();
    table
      .text('user_id')
      .notNullable()
      .references('id')
      .inTable('admin_user')
      .onDelete('CASCADE')
      .index();
    table.text('access_token');
    table.text('refresh_token');
    table.text('id_token');
    table.timestamp('access_token_expires_at', { useTz: true });
    table.timestamp('refresh_token_expires_at', { useTz: true });
    table.text('scope');
    table.text('password');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('admin_verification', (table) => {
    table.text('id').primary();
    table.text('identifier').notNullable().index();
    table.text('value').notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamps(true, true);
  });

  // The analytics role gets SELECT on new tables by default privileges.
  // These hold password hashes and session tokens, so take that back.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_readonly') THEN
        REVOKE ALL ON admin_user, admin_session, admin_account, admin_verification
          FROM analytics_readonly;
      END IF;
    END
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('admin_verification');
  await knex.schema.dropTableIfExists('admin_account');
  await knex.schema.dropTableIfExists('admin_session');
  await knex.schema.dropTableIfExists('admin_user');
}
