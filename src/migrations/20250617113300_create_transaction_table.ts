import type { Knex } from 'knex';

const tableName = 'transaction';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(tableName, (table) => {
    table.string('payhere_pay_id').primary();
    table
      .string('payhere_sub_id')
      .references('payhere_sub_id')
      .inTable('subscription')
      .onDelete('RESTRICT');
    table
      .enu(
        'status',
        ['SUCCESS', 'PENDING', 'CANCELLED', 'FAILED', 'CHARGEBACK'],
        {
          useNative: true,
          enumName: 'enum_transaction_status',
        },
      )
      .defaultTo('PENDING')
      .notNullable();

    // Bitcoin DCA related fields
    table.decimal('btc_price_at_purchase', 18, 2).nullable(); // 16 digits before decimal, 2 after for LKR prices
    table.bigint('satoshis_purchased').nullable();
    table.string('price_currency', 3).nullable();
    table.timestamp('coingecko_timestamp').nullable();
    table.boolean('settled').defaultTo(false).notNullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists(tableName)
    .raw('DROP TYPE enum_transaction_status;');
}
