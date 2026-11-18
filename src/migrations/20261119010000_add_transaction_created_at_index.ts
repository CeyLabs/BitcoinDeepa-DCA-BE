import type { Knex } from 'knex';

// Admin dashboard: transactions are listed newest first and filtered by date,
// and the analytics aggregate over recent days.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.index(['created_at'], 'idx_transaction_created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.dropIndex(['created_at'], 'idx_transaction_created_at');
  });
}
