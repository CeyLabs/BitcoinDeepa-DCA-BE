import type { Knex } from 'knex';

// The name Didit verified from the member's ID. first_name / last_name come
// from the Telegram profile (the member can change them), so bank account
// reviews compare against this instead.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.string('kyc_full_name').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('kyc_full_name');
  });
}
