import type { Knex } from 'knex';

const tableName = 'transaction';

export async function up(knex: Knex): Promise<void> {
  // Drop and recreate payment processor enum
  await knex.raw('DROP TYPE IF EXISTS enum_payment_processor CASCADE');

  // Add payment_processor to subscription table
  await knex.schema.alterTable('subscription', (table) => {
    table
      .enu('payment_processor', ['PAYHERE', 'CEYPAY'], {
        useNative: true,
        enumName: 'enum_payment_processor',
      })
      .defaultTo('PAYHERE')
      .notNullable();
  });

  // Update transaction table
  await knex.schema.alterTable(tableName, (table) => {
    // Drop the old single fee columns
    table.dropColumn('fee_basis_points');
    table.dropColumn('fee_amount');

    // Add payment processor fee columns with default 0
    table.integer('payment_processor_fee_basis_points').defaultTo(0).notNullable();
    table.decimal('payment_processor_fee_amount', 18, 2).defaultTo(0).notNullable();

    // Add BitcoinDeepa platform fee columns with default 0
    table.integer('bitcoindeepa_fee_basis_points').defaultTo(0).notNullable();
    table.decimal('bitcoindeepa_fee_amount', 18, 2).defaultTo(0).notNullable();
  });

  // Populate gross_amount from package prices for existing transactions
  await knex.raw(`
    UPDATE transaction t
    SET gross_amount = p.amount
    FROM subscription s
    JOIN package p ON s.package_id = p.id
    WHERE t.payhere_sub_id = s.payhere_sub_id
      AND t.gross_amount IS NULL;
  `);

  // Set net_amount equal to gross_amount for existing transactions (no fees were charged)
  await knex.raw(`
    UPDATE transaction
    SET net_amount = gross_amount
    WHERE net_amount IS NULL
      AND gross_amount IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Remove payment_processor from subscription table
  await knex.schema.alterTable('subscription', (table) => {
    table.dropColumn('payment_processor');
  });

  // Restore transaction table
  await knex.schema.alterTable(tableName, (table) => {
    // Remove split fee columns
    table.dropColumn('payment_processor_fee_basis_points');
    table.dropColumn('payment_processor_fee_amount');
    table.dropColumn('bitcoindeepa_fee_basis_points');
    table.dropColumn('bitcoindeepa_fee_amount');

    // Restore old single fee columns
    table.integer('fee_basis_points').nullable();
    table.decimal('fee_amount', 18, 2).nullable();
  });

  // Drop payment processor enum
  await knex.raw('DROP TYPE IF EXISTS enum_payment_processor;');
}
