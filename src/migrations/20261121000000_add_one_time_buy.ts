import type { Knex } from 'knex';

// One-time buys: a single PayHere checkout with no subscription behind it.
// Transactions now carry their owner (user_id) and kind directly, so read
// paths and settlement no longer have to go through subscription.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    "CREATE TYPE enum_purchase_kind AS ENUM ('RECURRING', 'ONE_TIME')",
  );

  await knex.schema.alterTable('transaction', (table) => {
    table
      .specificType('kind', 'enum_purchase_kind')
      .notNullable()
      .defaultTo('RECURRING');
    table
      .string('user_id')
      .nullable()
      .references('id')
      .inTable('user')
      .onDelete('RESTRICT');
    table
      .string('payhere_order_id')
      .nullable()
      .references('order_id')
      .inTable('payhere_order')
      .onDelete('RESTRICT');
    table.index(['user_id', 'created_at'], 'idx_transaction_user_created_at');
  });

  // Existing rows are all recurring: take the owner from their subscription.
  // Rows whose subscription has no user stay null (they had no owner before
  // either); new rows always get one.
  await knex.raw(`
    UPDATE "transaction" t
       SET user_id = s.user_id
      FROM subscription s
     WHERE s.payhere_sub_id = t.payhere_sub_id
  `);

  await knex.raw(`
    ALTER TABLE "transaction"
      ADD CONSTRAINT transaction_kind_refs_check CHECK (
        (kind = 'RECURRING' AND payhere_sub_id IS NOT NULL)
        OR (kind = 'ONE_TIME' AND payhere_sub_id IS NULL
            AND user_id IS NOT NULL AND payhere_order_id IS NOT NULL)
      ) NOT VALID
  `);
  // NOT VALID + VALIDATE: adding it doesn't block writes while old rows are
  // checked. Recurring rows always had a payhere_sub_id.
  await knex.raw(
    'ALTER TABLE "transaction" VALIDATE CONSTRAINT transaction_kind_refs_check',
  );

  await knex.schema.alterTable('payhere_order', (table) => {
    table
      .specificType('kind', 'enum_purchase_kind')
      .notNullable()
      .defaultTo('RECURRING');
    table.decimal('amount', 18, 2).nullable();
    table.string('currency', 3).nullable();
  });
  await knex.raw(
    'ALTER TABLE payhere_order ALTER COLUMN package_id DROP NOT NULL',
  );
  await knex.raw(`
    ALTER TABLE payhere_order
      ADD CONSTRAINT payhere_order_kind_check CHECK (
        (kind = 'RECURRING' AND package_id IS NOT NULL)
        OR (kind = 'ONE_TIME' AND package_id IS NULL
            AND amount IS NOT NULL AND currency IS NOT NULL)
      )
  `);
}

export async function down(knex: Knex): Promise<void> {
  // One-time rows can't be represented in the old schema
  const [{ count }] = await knex('transaction')
    .where('kind', 'ONE_TIME')
    .count<{ count: string }[]>('* as count');
  if (Number(count) > 0) {
    throw new Error(
      `Cannot roll back: ${count} one-time buy transactions exist`,
    );
  }
  await knex('payhere_order').where('kind', 'ONE_TIME').delete();

  await knex.raw(
    'ALTER TABLE payhere_order DROP CONSTRAINT IF EXISTS payhere_order_kind_check',
  );
  await knex.raw(
    'ALTER TABLE payhere_order ALTER COLUMN package_id SET NOT NULL',
  );
  await knex.schema.alterTable('payhere_order', (table) => {
    table.dropColumn('kind');
    table.dropColumn('amount');
    table.dropColumn('currency');
  });

  await knex.raw(
    'ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS transaction_kind_refs_check',
  );
  await knex.schema.alterTable('transaction', (table) => {
    table.dropIndex(
      ['user_id', 'created_at'],
      'idx_transaction_user_created_at',
    );
    table.dropColumn('payhere_order_id');
    table.dropColumn('user_id');
    table.dropColumn('kind');
  });
  await knex.raw('DROP TYPE IF EXISTS enum_purchase_kind');
}
