import * as fs from 'fs';
import * as path from 'path';
import { Knex, knex as createKnex } from 'knex';
import config from '../../knexfile';

/**
 * Loads the compiled dist/ migrations (.js) but names them by their .ts source file.
 * The knex CLI runs migrations through ts-node, so `knex_migrations` records "<name>.ts";
 * knex compares names including the extension, and would otherwise treat every recorded
 * migration as missing ("migration directory is corrupt").
 */
class CompiledMigrationSource implements Knex.MigrationSource<string> {
  constructor(private readonly directory: string) {}

  getMigrations(): Promise<string[]> {
    // Skip .d.ts / .js.map; sort so execution order matches the timestamped filenames
    const files = fs
      .readdirSync(this.directory)
      .filter((file) => file.endsWith('.js'))
      .sort();
    return Promise.resolve(files);
  }

  getMigrationName(file: string): string {
    return file.replace(/\.js$/, '.ts');
  }

  getMigration(file: string): Promise<Knex.Migration> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const migration = require(
      path.join(this.directory, file),
    ) as Knex.Migration;
    return Promise.resolve(migration);
  }
}

/**
 * Whether to migrate on startup. RUN_MIGRATIONS_ON_STARTUP=true|false wins; unset, it runs only
 * in production, so local `start:dev` never touches a (possibly shared) DB without asking.
 */
function shouldRunMigrations(nodeEnv: string): boolean {
  const flag = process.env.RUN_MIGRATIONS_ON_STARTUP;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return nodeEnv === 'production';
}

/**
 * Applies all pending migrations with a short-lived connection, before Nest boots.
 * Works without ts-node: from dist/ it runs the compiled .js migrations.
 *
 * - Concurrent instances are safe: knex takes its lock inside the batch transaction, so the
 *   others wait, then find nothing left to run.
 * - An older build starts against a newer schema (list validation is off), so a Railway rollback
 *   doesn't crash-loop. Migrations must stay compatible with the previous release, which keeps
 *   serving while the new one migrates.
 * - Run long or non-transactional (`config = { transaction: false }`) migrations by hand with the
 *   CLI: if the process is killed mid-run (e.g. Railway's 300s health check), knex's lock stays
 *   set and every start fails until `npx knex migrate:unlock`.
 * @throws {Error} If a migration fails, so the app never starts against a half-migrated schema
 */
export async function runMigrationsOnStartup(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (!shouldRunMigrations(nodeEnv)) {
    console.log(
      `[migrations] Skipped on startup (NODE_ENV=${nodeEnv}); set RUN_MIGRATIONS_ON_STARTUP=true or run \`npm run migrate\``,
    );
    return;
  }

  const knexConfig = config[nodeEnv] || config.development;

  // Resolve against this file so it works from both dist/ (compiled .js) and src/ (ts-node).
  const isCompiled = path.extname(__filename) === '.js';
  const directory = path.join(__dirname, '..', 'migrations');
  const db = createKnex({ ...knexConfig, pool: { min: 0, max: 1 } });

  try {
    const [batch, applied] = (await db.migrate.latest({
      tableName: knexConfig.migrations?.tableName ?? 'knex_migrations',
      // Recorded migrations missing from this build (rollback, older branch) are not an error
      disableMigrationsListValidation: true,
      ...(isCompiled
        ? { migrationSource: new CompiledMigrationSource(directory) }
        : { directory, loadExtensions: ['.ts'] }),
    })) as [number, string[]];

    if (applied.length === 0) {
      console.log(`[migrations] Schema up to date (NODE_ENV=${nodeEnv})`);
    } else {
      console.log(
        `[migrations] Batch ${batch}: applied ${applied.length} migration(s) (NODE_ENV=${nodeEnv})\n` +
          applied.map((name) => `  - ${name}`).join('\n'),
      );
    }
  } catch (error) {
    const locked =
      error instanceof Error && error.message.includes('already locked');
    const hint = locked
      ? '. A previous run was killed mid-migration: check the schema, then run `npx knex migrate:unlock`'
      : '';
    throw new Error(
      `[migrations] Failed on startup (NODE_ENV=${nodeEnv}); refusing to start the app${hint}`,
      { cause: error },
    );
  } finally {
    await db.destroy().catch(() => undefined);
  }
}
