/**
 * One-off: store the name Didit verified for members who were KYC-approved
 * before kyc_full_name existed, read from each member's Didit session. Also
 * re-scores their bank accounts still in review against that name (the old
 * score compared against the Telegram profile name).
 *
 *   bun run backfill:kyc-names            # dry run: prints what it would do
 *   bun run backfill:kyc-names --execute  # writes
 *
 * Uses the DB from .env / NODE_ENV and DIDIT_API_KEY / DIDIT_BASE_URL.
 * Members it can't resolve are fetched again from Didit when they next add a
 * bank account.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { knex as createKnex, type Knex } from 'knex';
import config from '../../knexfile';
import { DiditService } from '../modules/didit/didit.service';
import { matchAccountName } from '../modules/bank-account/name-match.util';

const DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  id: string;
  kyc_session_id: string | null;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const env = process.env.NODE_ENV || 'development';
  const db: Knex = createKnex((config as Record<string, Knex.Config>)[env]);
  const didit = new DiditService(new ConfigService());
  const counts = { stored: 0, rescored: 0, missing: 0, failed: 0 };

  try {
    const rows = await db<Row>('user')
      .select('id', 'kyc_session_id')
      .where('kyc_status', 'APPROVED')
      .whereNull('kyc_full_name')
      .orderBy('created_at');
    console.log(
      `${rows.length} approved member(s) without a verified name (${execute ? 'EXECUTE' : 'dry run'}, ${env})`,
    );

    for (const row of rows) {
      if (!row.kyc_session_id) {
        counts.missing++;
        console.log(`  ${row.id}: no Didit session`);
        continue;
      }
      await sleep(DELAY_MS);
      let name: string | null;
      try {
        const session = await didit.getSession(row.kyc_session_id);
        name = session?.status === 'Approved' ? session.verifiedName : null;
      } catch (error) {
        counts.failed++;
        console.log(`  ${row.id}: lookup failed: ${(error as Error).message}`);
        continue;
      }
      if (!name) {
        counts.missing++;
        console.log(`  ${row.id}: Didit has no approved ID name`);
        continue;
      }

      const pending = (await db('user_bank_account')
        .select('id', 'account_name')
        .where({
          user_id: row.id,
          status: 'PENDING_REVIEW',
          is_active: true,
        })) as { id: string; account_name: string }[];
      console.log(
        `  ${row.id}: ${name}${pending.length ? ` (+${pending.length} pending account(s) re-scored)` : ''}`,
      );
      if (!execute) continue;

      await db.transaction(async (trx) => {
        await trx('user')
          .where('id', row.id)
          .whereNull('kyc_full_name')
          .update({ kyc_full_name: name });
        for (const account of pending) {
          const { score } = matchAccountName(account.account_name, name);
          await trx('user_bank_account')
            .where('id', account.id)
            .update({ name_match_score: String(score) });
        }
      });
      counts.stored++;
      counts.rescored += pending.length;
    }
    console.log(
      `Done: ${counts.stored} stored, ${counts.rescored} account(s) re-scored, ${counts.missing} without a name, ${counts.failed} failed${execute ? '' : ' (dry run, nothing written)'}`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
