import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // user_public view depends on the "user" table; Postgres blocks a column
  // type rewrite (even to the same type) while a view rule references it.
  await knex.raw(`DROP VIEW IF EXISTS user_public`);

  await knex.schema.alterTable('user', (table) => {
    table.string('last_name').nullable().alter();
    table.string('address').nullable().alter();
    table.string('city').nullable().alter();
    table.string('country').nullable().alter();
  });

  await knex.raw(`
    CREATE OR REPLACE VIEW user_public AS
    SELECT
        id,
        created_at,
        updated_at,
        kyc_status,
        kyc_session_id,
        kyc_verified_at,
        kyc_rejection_reason
    FROM
        "user"
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP VIEW IF EXISTS user_public`);

  await knex.schema.alterTable('user', (table) => {
    table.string('last_name').notNullable().alter();
    table.string('address').notNullable().alter();
    table.string('city').notNullable().alter();
    table.string('country').notNullable().alter();
  });

  await knex.raw(`
    CREATE OR REPLACE VIEW user_public AS
    SELECT
        id,
        created_at,
        updated_at,
        kyc_status,
        kyc_session_id,
        kyc_verified_at,
        kyc_rejection_reason
    FROM
        "user"
  `);
}
