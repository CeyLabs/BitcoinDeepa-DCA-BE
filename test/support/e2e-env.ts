/**
 * Runs before every e2e test file (jest setupFiles), i.e. before AppModule is
 * imported. E2E tests need their OWN Postgres + Redis and refuse to run
 * against the project's default database.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/bitcoindeepa_dca
 *   TEST_REDIS_URL=redis://localhost:6380
 *
 * (The analytics migration grants on a database literally named
 * `bitcoindeepa_dca`, so the test database must use that name.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'dotenv';

const testDb = process.env.TEST_DATABASE_URL;
const testRedis = process.env.TEST_REDIS_URL;
if (!testDb || !testRedis) {
  throw new Error(
    'E2E tests need TEST_DATABASE_URL and TEST_REDIS_URL (a separate, disposable Postgres/Redis). See test/README.md.',
  );
}

// Never point the tests at the database configured in .env.
const envFile = path.join(__dirname, '../../.env');
if (fs.existsSync(envFile)) {
  const dev = parse(fs.readFileSync(envFile));
  const target = new URL(testDb);
  const sameUrl =
    dev.DATABASE_URL && new URL(dev.DATABASE_URL).host === target.host;
  const samePg =
    dev.PG_HOST &&
    `${dev.PG_HOST}:${dev.PG_PORT || '5432'}`.replace(
      'localhost',
      '127.0.0.1',
    ) ===
      `${target.hostname}:${target.port || '5432'}`.replace(
        'localhost',
        '127.0.0.1',
      );
  if (sameUrl || samePg) {
    throw new Error(
      'TEST_DATABASE_URL points at the database from .env - use a separate test database.',
    );
  }
}

// Explicit test configuration. Values set here win over .env (dotenv never
// overrides existing variables); external integrations are blanked out so
// nothing real is called - the tests stub those services anyway.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: testDb,
  REDIS_URL: testRedis,
  JWT_SECRET: 'test-jwt-secret',
  ENABLE_AUTH: 'true',
  ADMIN_API_KEY: 'test-admin-key',
  TELEGRAM_BOT_TOKEN: '123456:test-bot-token',
  LOG_GROUP_ID: '',
  PAYHERE_MERCHANT_ID: '1220000',
  PAYHERE_MERCHANT_SECRET: 'test-merchant-secret',
  PAYHERE_APP_ID: '',
  PAYHERE_APP_SECRET: '',
  PAYHERE_ENV: 'sandbox',
  PAYHERE_NOTIFY_URL: 'https://example.test/transaction/payhere-webhook',
  PAYHERE_RETURN_URL: 'https://example.test/dashboard',
  PAYHERE_CANCEL_URL: 'https://example.test/plans',
  PAYHERE_FEE_BASIS_POINTS: '100',
  BITCOINDEEPA_FEE_BASIS_POINTS: '100',
  BITCOINDEEPA_API_URL: '',
  BITCOINDEEPA_HMAC_SECRET: '',
  COINMARKETCAP_API_KEY: '',
  DIDIT_API_KEY: 'test-didit-key',
  DIDIT_WORKFLOW_ID: 'test-workflow',
  DIDIT_WEBHOOK_SECRET: 'test-didit-secret',
  DIDIT_BASE_URL: 'https://didit.invalid',
  ENABLE_BITCOIN_TRACKING: 'true',
  ANALYTICS_READONLY_PASSWORD: 'test-analytics',
});
