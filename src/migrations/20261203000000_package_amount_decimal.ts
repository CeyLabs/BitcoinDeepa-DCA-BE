import type { Knex } from 'knex';

/**
 * package.amount was a float (double precision), the only money column that
 * wasn't an exact decimal. Package amounts are whole LKR, so the cast is
 * lossless. 18,2 matches transaction.gross_amount, which is copied from it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE "package" ALTER COLUMN "amount" TYPE decimal(18, 2) USING round("amount"::numeric, 2)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE "package" ALTER COLUMN "amount" TYPE double precision USING "amount"::double precision',
  );
}
