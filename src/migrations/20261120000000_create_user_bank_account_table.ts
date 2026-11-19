import type { Knex } from 'knex';

// Bank accounts a user can sell sats into. Every account is reviewed by an
// admin (statement vs KYC name) before it can receive a payout. Approved
// accounts are registered with CeyPay (aggregator off-ramp) on approval.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_bank_account', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .string('user_id')
      .notNullable()
      .references('id')
      .inTable('user')
      .onDelete('RESTRICT');
    table.integer('bank_code').notNullable();
    table.string('bank_name').notNullable();
    table.string('account_number', 50).notNullable();
    table.string('account_name').notNullable();
    table
      .enu('status', ['PENDING_REVIEW', 'VERIFIED', 'REJECTED'], {
        useNative: true,
        enumName: 'enum_bank_account_status',
      })
      .notNullable()
      .defaultTo('PENDING_REVIEW');
    // Hint for the reviewer only (0..1), never an auto-approval
    table.decimal('name_match_score', 5, 4).nullable();
    table.text('statement_key').notNullable();
    table.text('rejection_reason').nullable();
    table.text('reviewed_by').nullable();
    table.timestamp('reviewed_at').nullable();
    table.uuid('ceypay_user_bank_id').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamps(true, true);

    table.index(['status', 'created_at'], 'idx_user_bank_account_status');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_user_bank_account_number
      ON user_bank_account (user_id, bank_code, account_number)
      WHERE is_active
  `);
  // One account per user in review or verified at a time
  await knex.raw(`
    CREATE UNIQUE INDEX uq_user_bank_account_current
      ON user_bank_account (user_id)
      WHERE is_active AND status IN ('PENDING_REVIEW', 'VERIFIED')
  `);

  await knex.schema.alterTable('user', (table) => {
    table.uuid('ceypay_user_id').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('ceypay_user_id');
  });
  await knex.schema.dropTableIfExists('user_bank_account');
  await knex.raw('DROP TYPE IF EXISTS enum_bank_account_status');
}
