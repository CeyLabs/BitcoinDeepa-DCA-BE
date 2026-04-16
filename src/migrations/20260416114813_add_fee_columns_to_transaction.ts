import type { Knex } from 'knex';

const tableName = 'transaction';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(tableName, (table) => {
    // Gross amount from PayHere (package amount)
    table.decimal('gross_amount', 18, 2).nullable();

    // Fee basis points at the time of transaction (1 basis point = 0.01%)
    table.integer('fee_basis_points').nullable();

    // Fee amount in LKR (or package currency)
    table.decimal('fee_amount', 18, 2).nullable();

    // Net amount after fee deduction (gross_amount - fee_amount)
    table.decimal('net_amount', 18, 2).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(tableName, (table) => {
    table.dropColumn('gross_amount');
    table.dropColumn('fee_basis_points');
    table.dropColumn('fee_amount');
    table.dropColumn('net_amount');
  });
}
