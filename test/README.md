# Tests

| Command            | What                                                                                    | Needs                                 |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------- |
| `bun run test`     | Unit tests (`src/**/*.spec.ts`): pure logic with mocks                                  | nothing                               |
| `bun run test:e2e` | E2E (`test/*.e2e-spec.ts`): the full Nest app over HTTP against a real Postgres + Redis | `TEST_DATABASE_URL`, `TEST_REDIS_URL` |
| `bun run test:cov` | Unit tests with coverage                                                                | nothing                               |

Run tests through these scripts, not `npx jest` directly: they set `--experimental-vm-modules`, which Jest needs to load `jose` (ESM-only) for the Telegram OIDC tests.

## E2E database

E2E tests **truncate tables**, so they need their own disposable Postgres and Redis and refuse to run against the database in `.env`. They also refuse a non-local `TEST_DATABASE_URL` unless `ALLOW_REMOTE_TEST_DB=1` is set.

```bash
docker run -d --name bd-test-pg -e POSTGRES_USER=bd_test -e POSTGRES_PASSWORD=bd_test \
  -e POSTGRES_DB=bitcoindeepa_dca -p 5433:5432 postgres:17-alpine
docker run -d --name bd-test-redis -p 6380:6379 redis:7-alpine

TEST_DATABASE_URL=postgresql://bd_test:bd_test@localhost:5433/bitcoindeepa_dca \
TEST_REDIS_URL=redis://localhost:6380 \
bun run test:e2e
```

The database must be named `bitcoindeepa_dca` (the analytics migration grants on that name). Migrations run automatically.

External services are stubbed in `test/support/test-app.ts`: Ceylon Cash BTC/USD (65,000), CoinMarketCap (24h change 1.5%, display only), BitcoinDeepa, Didit, PayHere's cancel API, CeyPay (USDT/LKR 330, so 1 BTC = 21,450,000 LKR) and R2. CeyPay webhooks are signed with a throwaway ED25519 key generated in `e2e-env.ts`; Telegram user DMs are mocked. Webhooks are sent with real PayHere md5 / Didit HMAC signatures using test secrets from `test/support/e2e-env.ts`. Cron jobs are stopped and called directly by the tests.

Set `TEST_LOGS=1` to see Nest logs while debugging.
