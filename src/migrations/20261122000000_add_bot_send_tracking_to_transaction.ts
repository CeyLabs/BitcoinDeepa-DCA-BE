import type { Knex } from 'knex';

// Settlement state for the BitcoinDeepa bot's Ed25519 send API:
// - bot_send_id: set while a send waits for approval in Telegram (the bot
//   answered 202 awaiting_approval); the settlement cron polls its status
// - settlement_failure: why the last send didn't go through. LOW_BALANCE rows
//   are retried at once when the bot reports a deposit to the DCA wallet
//   (POST /transaction/reset-retry-counts)
// Both nullable, no backfill: a quick ALTER on `transaction`.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.string('bot_send_id').nullable();
    table.text('settlement_failure').nullable();
  });
  await knex.raw(`
    ALTER TABLE "transaction"
      ADD CONSTRAINT transaction_settlement_failure_check CHECK (
        settlement_failure IS NULL OR settlement_failure IN
          ('LOW_BALANCE', 'REJECTED', 'AUTH', 'UNKNOWN', 'APPROVAL_REJECTED')
      )
  `);
  // The cron looks up sends awaiting approval on every tick
  await knex.raw(`
    CREATE INDEX idx_transaction_bot_send_pending
      ON "transaction" (bot_send_id)
      WHERE bot_send_id IS NOT NULL AND settled = false
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_transaction_bot_send_pending');
  await knex.raw(
    'ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS transaction_settlement_failure_check',
  );
  await knex.schema.alterTable('transaction', (table) => {
    table.dropColumn('settlement_failure');
    table.dropColumn('bot_send_id');
  });
}
