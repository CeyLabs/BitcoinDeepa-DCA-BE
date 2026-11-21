import type { Knex } from 'knex';

// package.amount was the only money column stored as a float (double
// precision). Make it decimal(18, 2) like transaction.gross_amount, which is
// copied from it. Lossless: package amounts are whole LKR.
//
// NOT compatible with releases before #74: once the column is decimal, pg
// returns it as a string, and only #74's conversions (PackageService.fromRow,
// toApiNumber on /subscription/current.dca_price and
// /transaction/list[].package_amount) turn it back into a number for the apps.
// Production migrates while the previous release is still serving, and a
// rollback starts an older build against this schema, so ship this only once
// every running build (and every rollback target) includes #74. See #76.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE "package" ALTER COLUMN "amount" TYPE decimal(18, 2) USING round("amount"::numeric, 2)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE "package" ALTER COLUMN "amount" TYPE double precision USING "amount"::double precision`,
  );
}
