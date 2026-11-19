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
import { generateKeyPairSync } from 'crypto';

const testDb = process.env.TEST_DATABASE_URL;
const testRedis = process.env.TEST_REDIS_URL;
if (!testDb || !testRedis) {
  throw new Error(
    'E2E tests need TEST_DATABASE_URL and TEST_REDIS_URL (a separate, disposable Postgres/Redis). See test/README.md.',
  );
}

// resetData() truncates every table: only ever run against a local database,
// unless ALLOW_REMOTE_TEST_DB=1 says the remote one is disposable.
const host = new URL(testDb).hostname;
if (
  !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) &&
  process.env.ALLOW_REMOTE_TEST_DB !== '1'
) {
  throw new Error(
    `TEST_DATABASE_URL host "${host}" is not local. E2E tests truncate tables; set ALLOW_REMOTE_TEST_DB=1 if that database is disposable.`,
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
  // the analytics migration grants on the database by name
  PG_DB: new URL(testDb).pathname.slice(1),
  REDIS_URL: testRedis,
  JWT_SECRET: 'test-jwt-secret',
  ENABLE_AUTH: 'true',
  ADMIN_API_KEY: 'test-admin-key',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-chars',
  BETTER_AUTH_URL: 'http://localhost:3000',
  ADMIN_APP_URL: 'http://localhost:5173',
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
  BUY_MIN_LKR: '100',
  BUY_MAX_LKR: '100000',
  BUY_DAILY_MAX_LKR: '250000',
  BUY_ORDER_TTL_MINUTES: '30',
  BUY_LINKS_PER_HOUR: '10',
  BITCOINDEEPA_SELL_FEE_BASIS_POINTS: '100',
  SELL_QUOTE_TTL_SECONDS: '60',
  SELL_MIN_SATS: '1000',
  SELL_ENABLED: 'true',
  // never inherit a developer's dev-only mock from .env
  BITCOINDEEPA_COLLECT_MOCK: 'false',
  CEYPAY_API_URL: 'https://ceypay.invalid',
  CEYPAY_API_KEY_ID: 'ak_live_test',
  CEYPAY_API_SECRET: 'sk_live_test',
  // the CeyPay webhook URL is derived from it
  BASE_URL: 'https://example.test/',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET: '',
});

// CeyPay signs webhooks with ED25519; tests sign with this throwaway key.
const ceypayWebhookKeys = generateKeyPairSync('ed25519');
process.env.CEYPAY_WEBHOOK_PUBLIC_KEY = ceypayWebhookKeys.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
process.env.TEST_CEYPAY_WEBHOOK_PRIVATE_KEY = ceypayWebhookKeys.privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
