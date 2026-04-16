import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table
      .enu(
        'kyc_status',
        [
          'NOT_STARTED',
          'IN_PROGRESS',
          'APPROVED',
          'DECLINED',
          'KYC_EXPIRED',
          'IN_REVIEW',
          'EXPIRED',
          'ABANDONED',
        ],
        {
          useNative: true,
          enumName: 'enum_kyc_status',
        },
      )
      .defaultTo('NOT_STARTED')
      .notNullable();
    table.string('kyc_session_id').nullable();
    table.timestamp('kyc_verified_at').nullable();
    table.text('kyc_rejection_reason').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('kyc_status');
    table.dropColumn('kyc_session_id');
    table.dropColumn('kyc_verified_at');
    table.dropColumn('kyc_rejection_reason');
  });

  // Drop the native enum type
  await knex.raw('DROP TYPE IF EXISTS enum_kyc_status');
}
