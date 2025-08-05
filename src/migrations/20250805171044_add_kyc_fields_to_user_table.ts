import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table
      .enum('kyc_status', [
        'Not Started',
        'In Progress',
        'Approved',
        'Declined',
        'Kyc Expired',
        'In Review',
        'Expired',
        'Abandoned',
      ])
      .defaultTo('Not Started');
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
}
