import type { Knex } from 'knex';

// payhere_order is the buy side's order (a checkout we started), the
// counterpart of sell_order: call it buy_order. A rename only, no data moves.
//
// The previous release keeps serving while this runs, and a rollback starts
// an older build against this schema, so a view keeps the old name working
// (a plain single-table view: Postgres lets it be read, written and locked
// like the table). Drop the view in a later release, once no build that says
// payhere_order can be started again.
//
// Columns named payhere_order_id (transaction, subscription) keep their name:
// they hold PayHere's order_id.
const RENAMED: [from: string, to: string][] = [
  ['payhere_order_kind_check', 'buy_order_kind_check'],
  ['payhere_order_user_id_foreign', 'buy_order_user_id_foreign'],
  ['payhere_order_package_id_foreign', 'buy_order_package_id_foreign'],
];

async function renameConstraints(
  knex: Knex,
  table: string,
  pairs: [string, string][],
): Promise<void> {
  for (const [from, to] of pairs) {
    const { rows } = await knex.raw<{ rows: unknown[] }>(
      `SELECT 1 FROM pg_constraint
        WHERE conname = ? AND conrelid = ?::regclass`,
      [from, table],
    );
    if (rows.length > 0) {
      await knex.raw('ALTER TABLE ?? RENAME CONSTRAINT ?? TO ??', [
        table,
        from,
        to,
      ]);
    }
  }
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE payhere_order RENAME TO buy_order');
  await knex.raw(
    'ALTER INDEX IF EXISTS payhere_order_pkey RENAME TO buy_order_pkey',
  );
  await knex.raw(
    'ALTER INDEX IF EXISTS idx_payhere_order_user_created_at RENAME TO idx_buy_order_user_created_at',
  );
  await renameConstraints(knex, 'buy_order', RENAMED);
  await knex.raw('CREATE VIEW payhere_order AS SELECT * FROM buy_order');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP VIEW IF EXISTS payhere_order');
  await renameConstraints(
    knex,
    'buy_order',
    RENAMED.map(([from, to]) => [to, from]),
  );
  await knex.raw(
    'ALTER INDEX IF EXISTS idx_buy_order_user_created_at RENAME TO idx_payhere_order_user_created_at',
  );
  await knex.raw(
    'ALTER INDEX IF EXISTS buy_order_pkey RENAME TO payhere_order_pkey',
  );
  await knex.raw('ALTER TABLE buy_order RENAME TO payhere_order');
}
