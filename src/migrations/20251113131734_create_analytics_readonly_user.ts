import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const analyticsPassword = process.env.ANALYTICS_READONLY_PASSWORD;
  const databaseName = process.env.PG_DB;

  if (!analyticsPassword) {
    throw new Error(
      'ANALYTICS_READONLY_PASSWORD environment variable is required for this migration',
    );
  }

  if (!databaseName) {
    throw new Error(
      'PG_DB environment variable is required for this migration',
    );
  }

  // 1. Create the sanitized view for user table
  await knex.raw(`
    CREATE VIEW user_public AS
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

  // 2. Create the analytics readonly user
  await knex.raw(`
    CREATE USER analytics_readonly WITH PASSWORD ?
  `, [analyticsPassword]);

  // 3. Grant connect permission to the database
  await knex.raw(`
    GRANT CONNECT ON DATABASE ${databaseName} TO analytics_readonly
  `);

  // 4. Grant usage on the schema
  await knex.raw(`
    GRANT USAGE ON SCHEMA public TO analytics_readonly
  `);

  // 5. Grant SELECT on ALL tables in the schema (including future ones)
  await knex.raw(`
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO analytics_readonly
  `);

  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT ON TABLES TO analytics_readonly
  `);

  // 6. Explicitly REVOKE access to sensitive tables
  await knex.raw(`
    REVOKE SELECT ON "user" FROM analytics_readonly
  `);

  await knex.raw(`
    REVOKE SELECT ON "log" FROM analytics_readonly
  `);

  // 7. Grant access to the sanitized view
  await knex.raw(`
    GRANT SELECT ON user_public TO analytics_readonly
  `);
}

export async function down(knex: Knex): Promise<void> {
  const databaseName = process.env.PG_DB;

  if (!databaseName) {
    throw new Error(
      'PG_DB environment variable is required for this migration rollback',
    );
  }

  // Revoke all permissions and drop user
  await knex.raw(`
    REVOKE SELECT ON user_public FROM analytics_readonly
  `);

  await knex.raw(`
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM analytics_readonly
  `);

  await knex.raw(`
    REVOKE USAGE ON SCHEMA public FROM analytics_readonly
  `);

  await knex.raw(`
    REVOKE CONNECT ON DATABASE ${databaseName} FROM analytics_readonly
  `);

  await knex.raw(`
    DROP USER IF EXISTS analytics_readonly
  `);

  await knex.raw(`
    DROP VIEW IF EXISTS user_public
  `);
}
