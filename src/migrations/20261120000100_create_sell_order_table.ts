import type { Knex } from 'knex';

const SELL_STATUSES = [
  'QUOTED',
  'EXPIRED',
  'SATS_COLLECTED',
  'PAYOUT_PENDING',
  'COMPLETED',
  'REFUNDED',
  'NEEDS_REVIEW',
];

// A user selling sats for LKR. The LKR amount is priced with our own FX
// (Ceylon Cash BTC buying rate); CeyPay pays it out from our LKR float.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sell_order', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .string('user_id')
      .notNullable()
      .references('id')
      .inTable('user')
      .onDelete('RESTRICT');
    table
      .uuid('user_bank_account_id')
      .notNullable()
      .references('id')
      .inTable('user_bank_account')
      .onDelete('RESTRICT');
    table
      .enu('status', SELL_STATUSES, {
        useNative: true,
        enumName: 'enum_sell_status',
      })
      .notNullable()
      .defaultTo('QUOTED');

    table.bigInteger('sats').notNullable();
    table.integer('fee_basis_points').notNullable();
    table.bigInteger('fee_sats').notNullable();
    table.bigInteger('net_sats').notNullable();
    table.decimal('btc_lkr_buying_rate', 18, 2).notNullable();
    table.decimal('btc_usd_price', 18, 2).nullable();
    // What we promised the user
    table.decimal('amount_lkr', 18, 2).notNullable();
    table.timestamp('expires_at').notNullable();

    // CeyPay bookkeeping (its quote is in USDT)
    table.uuid('fx_lock_id').nullable();
    table.decimal('ceypay_amount_usdt', 24, 8).nullable();
    table.decimal('ceypay_rate_usdt_lkr', 18, 6).nullable();
    table.uuid('ceypay_payment_id').nullable().unique();
    table.string('bank_ref').nullable();

    table.text('failure_reason').nullable();
    table.boolean('refunded').notNullable().defaultTo(false);
    table.integer('retry_count').notNullable().defaultTo(0);
    table.timestamp('last_retry_at').nullable();
    table.timestamp('completed_at').nullable();
    table.timestamps(true, true);

    table.index(['user_id', 'created_at'], 'idx_sell_order_user');
    table.index(['status', 'retry_count'], 'idx_sell_order_status_retry');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sell_order');
  await knex.raw('DROP TYPE IF EXISTS enum_sell_status');
}
