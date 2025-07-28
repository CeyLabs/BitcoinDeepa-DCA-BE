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

    // Settlement retry tracking fields
    table.integer('retry_count').defaultTo(0).notNullable();
    table.timestamp('last_retry_at').nullable();

    table.timestamps(true, true);

    // Performance indexes for settlement queries
    table.index(
      ['status', 'settled', 'retry_count'],
      'idx_transaction_settlement_retry',
    );
    table.index(['last_retry_at'], 'idx_transaction_last_retry_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists(tableName)
    .raw('DROP TYPE IF EXISTS enum_transaction_status;');
}
