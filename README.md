<!-- markdownlint-disable-next-line MD041 -->
<br>

<a href="https://bitcoindeepa.com"><picture><source media="(prefers-color-scheme: dark)"
  srcset="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/wordmark-dark.svg"><img
  alt="Bitcoin Deepa: Pearl of Satoshi" width="260"
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/wordmark.svg"></picture></a>

<p>The backend for stacking sats on a schedule: paid in rupees through PayHere, sent to members over Lightning.<br>
<strong>Powers the Bitcoin Deepa Mini App</strong>, open source and AGPL-3.0 licensed.</p>

<p>
<a href="https://bitcoindeepa.com"><picture><source media="(prefers-color-scheme: dark)"
  srcset="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-website-dark.svg"><img
  alt="Website" height="34"
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-website.svg"></picture></a>
<a href="https://t.me/BitcoinDeepa"><picture><source media="(prefers-color-scheme: dark)"
  srcset="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-telegram-dark.svg"><img
  alt="Telegram" height="34"
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-telegram.svg"></picture></a>
<a href="https://x.com/bitcoindeepa"><picture><source media="(prefers-color-scheme: dark)"
  srcset="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-x-dark.svg"><img
  alt="Follow on X" height="34"
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-x.svg"></picture></a>
<a href="https://github.com/bitcoindeepa/app-backend/blob/main/LICENSE"><picture><source
  media="(prefers-color-scheme: dark)"
  srcset="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-license-agpl-dark.svg"><img
  alt="License: AGPL-3.0" height="34"
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-license-agpl.svg"></picture></a>
<a href="https://github.com/bitcoindeepa/.github/blob/main/CONTRIBUTING.md"><picture><source
  media="(prefers-color-scheme: dark)"
  srcset="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-contribute-dark.svg"><img
  alt="Contribute" height="34"
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/pill-contribute.svg"></picture></a>
</p>

<br>

This is the API behind the [Mini App](https://github.com/bitcoindeepa/app-frontend) and the
[admin dashboard](https://github.com/bitcoindeepa/admin-frontend). Members pay in LKR, and the sats go from our DCA
wallet to their wallet in the [Bitcoin Deepa bot](https://github.com/bitcoindeepa/bot).

## What's in it

- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-plans.svg">
  **Plans and subscriptions**:
  weekly and monthly DCA plans in LKR, charged by PayHere until the member cancels
- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-payments.svg">
  **Payments**: PayHere checkout
  links for plans and one-time buys, a signed webhook, fees and buy limits
- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-settlement.svg">
  **Settlement**: prices each
  payment in sats and sends them from the DCA wallet through the bot's signed API, with retries
- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-sell.svg">
  **Sell**: sats to LKR, paid to a
  reviewed bank account by CeyPay (off unless `SELL_ENABLED=true`)
- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-p2p.svg">
  **P2P sends**: members send sats from
  their own bot wallet to another member's @username
- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-auth.svg">
  **Sign-in and KYC**: sessions from
  Telegram Mini App data or Log In with Telegram, and ID checks through Didit
- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-admin.svg">
  **Admin API**: email sign-in
  (Better Auth), analytics, members, transactions and bank account reviews
- <img width="20" height="20" alt=""
  src="https://raw.githubusercontent.com/bitcoindeepa/app-backend/main/.github/assets/readme/icon-jobs.svg">
  **Background jobs**: settlement
  retries, rate logging, price backfills, sell order follow-up and review reminders

## Run it

```bash
git clone https://github.com/bitcoindeepa/app-backend.git
cd app-backend
bun install
cp .env.template .env    # set NODE_ENV=development
docker compose up -d     # Postgres 16 and Redis 7
bun run migrate
bun run seed             # sample plans and users
bun run start:dev
```

The API listens on [localhost:3000](http://localhost:3000); `GET /health` checks the database and Redis. You need
[Bun](https://bun.sh) and Node.js 22 (`.nvmrc` pins 22.12.0) and Docker for the local services.

- **Set `NODE_ENV=development` first.** The template says `production`, which makes PayHere, CeyPay, the bot key
  and more required at startup. `JWT_SECRET` is required everywhere.
- **Migrations need `ANALYTICS_READONLY_PASSWORD` and `PG_DB`.** Any value works locally.
- **No Telegram locally?** `ENABLE_AUTH=false` signs every request in as `MOCK_TG_ID`. Production refuses it.
- **`bun run build`** compiles to `dist/`; `bun run start:prod` runs it. `bun run lint` and `bun run prettier`
  fix style.

<details>
<summary><strong>Environment variables</strong></summary>

<br>

`src/config/env.validation.ts` checks these at startup, and the app won't boot on a missing or bad value.
"Production" below means required when `NODE_ENV=production`. `.env.template` has comments for each.

**Server:**

| Variable | What it does |
| --- | --- |
| `NODE_ENV` | `development`, `production`, `test` or `localhost`; also picks the knexfile config |
| `PORT` | Port to listen on; defaults to 3000 |
| `BASE_URL` | Public URL of this API (production) |
| `APP_URL` | User app origin: credentialed CORS, CSRF check and web login return (production) |
| `APP_COOKIE_SAME_SITE` | `none` for a dev/staging app on another site; refused in production |
| `CORS_ORIGIN` | CORS for every other origin, without credentials; defaults to `*` |
| `TRUST_PROXY` | Proxy hops or IPs in front of the API, so rate limits see the real client (production) |
| `LOG_FORMAT` | `json` or `pretty` for the development API call log |
| `RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME` | Set by Railway; switches development logs to JSON lines |

**Database and cache:**

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres connection string; used before the `PG_*` values |
| `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PW` | Postgres connection as separate values |
| `RUN_MIGRATIONS_ON_STARTUP` | `true` or `false`; unset, migrations run on start only in production |
| `ANALYTICS_READONLY_PASSWORD` | Password for the read-only analytics role, created by a migration |
| `REDIS_URL` | Redis connection string; without Redis, caching and rate limits are off |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_DATABASE` | Redis as separate values |
| `REDIS_TTL_DEFAULT` | Default cache lifetime in seconds (300) |

**Sign-in:**

| Variable | What it does |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Checks Mini App init data, sends DMs and ops logs (production) |
| `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET` | Log In with Telegram, from BotFather (production) |
| `TELEGRAM_OIDC_REDIRECT_URI` | Login callback; defaults to `BASE_URL/auth/telegram/callback` |
| `TELEGRAM_OIDC_SCOPE` | Defaults to `openid profile`; must keep `profile` |
| `JWT_SECRET` | Signs and checks the legacy 7-day JWTs (always required) |
| `LEGACY_JWT_ISSUE` | `false` stops issuing legacy JWTs (those routes answer 410) |
| `ENABLE_AUTH` | `false` uses a mock user (development only) |
| `MOCK_TG_ID` | Telegram id of that mock user |

**Admin:**

| Variable | What it does |
| --- | --- |
| `BETTER_AUTH_SECRET` | Admin session secret, 32+ characters (production) |
| `BETTER_AUTH_URL` | Better Auth's URL if it isn't `BASE_URL` |
| `ADMIN_APP_URL` | Admin dashboard origin(s), comma-separated (production) |
| `ADMIN_COOKIE_SAME_SITE` | `none` for a dev/staging dashboard on another site; refused in production |
| `ADMIN_DASHBOARD_URL` | Dashboard link in Telegram alerts; defaults to the first `ADMIN_APP_URL` |
| `ADMIN_API_KEY` | `x-admin-key` for the internal transaction endpoints |
| `ADMIN_PASSWORD` | Password for `admin:create` without the prompt |
| `LOG_GROUP_ID`, `LOG_TOPIC_ID` | Telegram group and topic for ops logs and alerts |

**Payments and buys:**

| Variable | What it does |
| --- | --- |
| `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET` | Sign checkout links and check webhooks (production) |
| `PAYHERE_APP_ID`, `PAYHERE_APP_SECRET` | PayHere OAuth app, used to cancel subscriptions (production) |
| `PAYHERE_ENV` | `sandbox` or `live` |
| `PAYHERE_RETURN_URL`, `PAYHERE_CANCEL_URL` | Where PayHere sends the member after checkout |
| `PAYHERE_NOTIFY_URL` | Webhook URL given to PayHere: `BASE_URL/transaction/payhere-webhook` |
| `PAYHERE_FEE_BASIS_POINTS` | PayHere fee taken off each buy (100 = 1%) |
| `BITCOINDEEPA_FEE_BASIS_POINTS` | Bitcoin Deepa fee taken off each buy |
| `BUY_MIN_LKR`, `BUY_MAX_LKR` | One-time buy limits per buy (100 and 100,000) |
| `BUY_DAILY_MAX_LKR` | One-time buys per member in a rolling 24 hours (250,000) |
| `BUY_ORDER_TTL_MINUTES` | Minutes a one-time checkout can be paid (30) |
| `BUY_LINKS_PER_HOUR` | One-time checkouts per member per hour (10) |

**Prices:**

| Variable | What it does |
| --- | --- |
| `ENABLE_BITCOIN_TRACKING` | `false` stops the rate log and price backfill jobs |
| `EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS` | Oldest logged rate that may price a payment (180, max 900, 0 = never) |
| `COINMARKETCAP_API_KEY` | 24-hour change shown in the wallet; display only, never a price |
| `BTC_PRICE_CACHE_TTL` | Cache seconds for that 24-hour change |

**Bot wallet and P2P:**

| Variable | What it does |
| --- | --- |
| `BITCOINDEEPA_API_URL`, `BITCOINDEEPA_WALLET_ID` | Bot wallet API and our DCA wallet id (production) |
| `BITCOINDEEPA_PRIVATE_KEY_PEM` | Ed25519 key that signs every bot call; can move funds, keep it secret (production) |
| `BITCOINDEEPA_TIMEOUT`, `BITCOINDEEPA_SEND_TIMEOUT` | Bot call timeouts in ms (10,000; 95,000 for sends) |
| `BITCOINDEEPA_CALLBACK_SECRET` | When set, the bot's deposit callback must send it |
| `BITCOINDEEPA_COLLECT_MOCK` | Removed; only logs a warning if still set |
| `P2P_ENABLED` | `false` turns P2P sends off; also off without the bot key |

**Sell:**

| Variable | What it does |
| --- | --- |
| `SELL_ENABLED` | `true` turns selling on |
| `BITCOINDEEPA_SELL_FEE_BASIS_POINTS` | Fee taken off each sale's LKR |
| `SELL_BANK_CHARGE_LKR` | Flat bank charge per sale (30) |
| `SELL_QUOTE_TTL_SECONDS` | How long a quote holds |
| `SELL_COLLECT_WINDOW_SECONDS` | Time to approve the payment after confirming (300, 60 to 900) |
| `SELL_MIN_SATS`, `SELL_MAX_SATS` | Per-sale limits (1,000 and 5,000,000) |
| `SELL_DAILY_MAX_SATS` | Per member in a rolling 24 hours (20,000,000) |
| `CEYPAY_API_URL`, `CEYPAY_API_KEY_ID`, `CEYPAY_API_SECRET` | CeyPay API; its USDT/LKR prices every buy (production) |
| `CEYPAY_WEBHOOK_PUBLIC_KEY` | Checks CeyPay's signed webhooks (production with selling on) |
| `CEYPAY_WEBHOOK_URL` | Defaults to `BASE_URL/sell/ceypay-webhook` |
| `CEYPAY_TIMEOUT` | CeyPay call timeout in ms |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Private bucket for bank statements |
| `R2_ENDPOINT` | Any S3-compatible server instead of R2 (local MinIO, tests) |

**KYC:**

| Variable | What it does |
| --- | --- |
| `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` | Didit verification sessions; without them KYC is off |
| `DIDIT_WEBHOOK_SECRET` | Checks Didit webhooks (production) |
| `DIDIT_REDIRECT_URL` | Where Didit sends the member afterwards |
| `DIDIT_BASE_URL` | Defaults to `https://verification.didit.me` |

**Tests:**

| Variable | What it does |
| --- | --- |
| `TEST_DATABASE_URL`, `TEST_REDIS_URL` | Disposable Postgres and Redis for the e2e tests |
| `ALLOW_REMOTE_TEST_DB` | `1` allows a non-local test database |
| `TEST_LOGS` | `1` shows Nest logs in tests |
| `TEST_CEYPAY_WEBHOOK_PRIVATE_KEY` | Set by the test setup itself |

</details>

## What it's made of

[NestJS 11](https://nestjs.com) and [TypeScript](https://www.typescriptlang.org) on Node.js 22, with
[Bun](https://bun.sh) as the package manager. [PostgreSQL](https://www.postgresql.org) through
[Knex](https://knexjs.org), [Redis](https://redis.io) through [ioredis](https://github.com/redis/ioredis), jobs from
[@nestjs/schedule](https://docs.nestjs.com/techniques/task-scheduling), admin sign-in from
[Better Auth](https://www.better-auth.com), and money math with [big.js](https://github.com/MikeMcl/big.js), never
floats.

```text
src/
├── config/           # Env validation
├── migrations/       # Knex migrations
├── seeds/            # Sample plans, users, subscriptions
├── scripts/          # create-admin and one-off backfills
└── modules/
    ├── auth/         # Sessions, Telegram login, guards
    ├── user/ didit/  # Profiles, usernames, KYC
    ├── package/ subscription/ buy/ payhere/
    ├── transaction/  # PayHere webhook, history, holds
    ├── settlement/ bitcoindeepa/  # Sending sats
    ├── bitcoin-price/ ceypay/ coinmarketcap/
    ├── sell/ bank-account/ storage/
    ├── p2p/          # Member-to-member sends
    ├── admin/        # Dashboard API
    └── health/ knex/ redis/ telegram-logger/
test/                 # E2E tests
scripts/              # Signed bot API calls (move real sats)
```

## How a buy becomes sats

1. The app asks for a checkout: `POST /subscription/payhere-link` for a plan, `POST /buy/payhere-link` for a
   one-time buy. Both need approved KYC. The backend saves a `buy_order` first, because PayHere only signs the
   merchant, order, amount and currency.
2. PayHere posts the result to `POST /transaction/payhere-webhook` (MD5-signed). The payment is priced at
   BTC/LKR = Ceylon Cash BTC/USD × CeyPay USDT/LKR, after the PayHere and Bitcoin Deepa fees.
3. If the price is down, a logged rate up to 3 minutes old is used. Otherwise a job prices the payment once the
   price is back.
4. The settlement job sends the sats from the DCA wallet to the member's bot wallet. The memo is unique per
   payment, so a retry can't pay twice. Failed sends back off (2^n minutes, 5 attempts); large sends wait for
   approval in Telegram.
5. Settlement pays what the signed webhook recorded. It no longer asks PayHere's API about each payment.
6. A one-time buy paid twice, paid late or over the daily limit is held until a person releases it.

<details>
<summary><strong>API reference</strong></summary>

<br>

Signed-in routes take a session (`Authorization: Bearer <token>` from the Mini App, or the session cookie from the
web login). Webhooks are public and signed. "KYC" means the member's KYC must be approved.

**Sign-in** (`/auth`)

- `GET /auth/telegram/start`, `GET /auth/telegram/callback`: web login (Telegram OIDC), sets the session cookie
- `POST /auth/telegram/miniapp`: `{ initData }` from the Mini App, returns a session token
- `GET /auth/me`, `POST /auth/logout`, `POST /auth/logout-all`
- Legacy `POST /auth/telegram` and `POST /auth/telegram-oidc`: 7-day JWTs, 410 once `LEGACY_JWT_ISSUE=false`

**Members** (`/user`)

- `POST /user`: complete the profile (email, phone, address, city, country)
- `GET /user/me`: the profile, with `is_profile_complete` and `avatar_seed`
- `GET /user/username/availability?username=`, `POST /user/username`: claim a @username, once
- `PATCH /user/avatar`: `{ seed }` for the avatar
- `GET /user/exists/:telegramId` (public)
- `POST /user/kyc/initiate`, `GET /user/kyc/status`; `POST /didit/webhook` (public, signed)

**Plans and buys** (`/package`, `/subscription`, `/buy`)

- `GET /package`: all plans (public)
- `GET /subscription/current`, `POST /subscription/cancel`
- `POST /subscription/payhere-link`: `{ package_id }`, returns a recurring checkout link (KYC)
- `GET /buy/price`: live BTC/LKR, fees and buy limits
- `POST /buy/payhere-link`: `{ amount_lkr }` in whole rupees, returns `{ link, order_id }` (KYC)
- `GET /buy/orders/:orderId`: awaiting payment, or the payment's status, sats and settlement

**Transactions** (`/transaction`)

- `POST /transaction/payhere-webhook`: PayHere notifications (public, MD5-signed)
- `GET /transaction/list?page=&limit=`: purchases and sales together, newest first (limit 10, max 100). Each
  item has a `type`: `BUY` is the transaction row with its plan; `SELL` is `{ type, created_at, sell_order }`.
  Treat an item without `type` as `BUY`
- `GET /transaction/latest`, `GET /transaction/dca-summary` (total sats and average price)
- `GET /transaction/bot-history?limit=&offset=`: the member's bot wallet transfers, with purchases marked
- `POST /transaction/reset-retry-counts`: the bot's callback when the DCA wallet receives sats
- `POST /transaction/reset-retry-count/:paymentId`, `POST /transaction/release-hold/:paymentId`: internal,
  need `x-admin-key`

**Sell and bank accounts** (503 while selling is off)

- `GET /sell/price`; `POST /sell/quote` with `{ sats }` (KYC and a verified bank account)
- `POST /sell/orders/:id/confirm`, `POST /sell/orders/:id/pay`, `POST /sell/orders/:id/cancel`
- `GET /sell/orders`, `GET /sell/orders/:id`
- `POST /sell/ceypay-webhook`: payout result (public, Ed25519-signed)
- `GET /bank-accounts/banks`, `GET /bank-accounts`, `DELETE /bank-accounts/:id`
- `POST /bank-accounts/statement-upload`, then `POST /bank-accounts` (KYC)

**P2P** (`/p2p`, needs a full session)

- `GET /p2p/me`, `POST /p2p/resolve`, `POST /p2p/send`, `GET /p2p/transfers/:id`

**Admin** (admin session cookie)

- `/api/admin-auth/*`: Better Auth sign-in, sign-out and session
- `GET /admin/me`, `GET /admin/analytics/summary`, `GET /admin/analytics/daily?days=7|30|90`
- `GET /admin/transactions`, `GET /admin/members` (paged, filtered, searchable)
- `GET /admin/admins`, `POST /admin/admins`
- `GET /admin/bank-reviews`, `GET /admin/bank-reviews/pending-count`, `GET /admin/bank-reviews/:id/statement`,
  `POST /admin/bank-reviews/:id/approve`, `POST /admin/bank-reviews/:id/reject`

**Health** (`/health`)

- `GET /health`: memory, disk, database and Redis; `GET /health/simple`: a plain OK

</details>

<details>
<summary><strong>Background jobs</strong></summary>

<br>

All run inside the app with `@nestjs/schedule`. Some claim a Redis key so they run once across instances.

- **Every 10 seconds:** send sats for unsettled payments; follow sell payment requests
- **Every 30 seconds:** retry sell payouts
- **Every minute:** log the BTC/LKR rate; price payments saved without one; fill missing payment owners; poll sends
  waiting for approval; expire sell quotes; move stuck sell orders to review
- **Every 5 minutes:** ask CeyPay about payouts still pending after 10 minutes
- **Every 10 minutes:** alert once on a payout pending over 2 hours
- **Every 3 hours:** remind the ops group of sales, held buys and payments that need a person
- **Every 6 hours:** alert on paid payments too old to price automatically
- **Daily at 3 am:** delete expired sessions and login attempts

</details>

## Database

PostgreSQL, with Knex migrations in `src/migrations` and seeds in `src/seeds`.

- `bun run migrate` applies pending migrations; `bun run migrate:rollback` undoes the last batch.
- `bun run db:reset` rolls back, migrates and seeds again.
- New migration: `npx knex migrate:make <name>`. Keep it compatible with the release before it, which keeps serving
  while the new one migrates.
- In production the app applies pending migrations itself on startup, before it serves anything. A migration that
  fails stops the start. Run long or non-transactional migrations by hand; if one is killed mid-run, the app won't
  start until `npx knex migrate:unlock`.
- `bun run admin:create --email <email> --name "<name>"` creates the first dashboard admin.
- `bun run backfill:payhere-orders` and `bun run backfill:kyc-names` are one-off backfills: dry run by default,
  `--execute` writes.

## Tests

```bash
bun run test       # unit tests, no services needed
bun run test:e2e   # full app against Postgres and Redis
```

The e2e tests truncate tables, so they refuse the database in `.env` and need their own `TEST_DATABASE_URL` and
`TEST_REDIS_URL`. See [test/README.md][test/README.md]. CI runs type checks, unit and e2e tests on every pull
request.

## Deployment

It runs on [Railway](https://railway.app) (`railway.json`): Nixpacks build with Node 22.12.0, `npm run start:prod`,
health check on `/health/simple`, and a restart on failure. A `Dockerfile` is also included.

- Point PayHere at `BASE_URL/transaction/payhere-webhook` (`PAYHERE_NOTIFY_URL`); it must be public.
- Register `BASE_URL/auth/telegram/callback` as an allowed URL for Log In with Telegram in BotFather.
- Production refuses to start without the variables marked "production" above, and refuses `ENABLE_AUTH=false`.
- Use a different bot key per environment. It can pay from the DCA wallet and from linked members' wallets.

## Help out

Fix a bug, add a test or improve the docs. Read the
[contributing guide](https://github.com/bitcoindeepa/.github/blob/main/CONTRIBUTING.md), then open an issue or
say hello on [Telegram](https://t.me/BitcoinDeepa). Security problems go through the
[security policy](https://github.com/bitcoindeepa/.github/blob/main/SECURITY.md), not a public issue.

## Licence

[AGPL-3.0](https://github.com/bitcoindeepa/app-backend/blob/main/LICENSE): use,
study, change and share this code. If you run a changed version for other people, including as a web
service, you share your source under the same licence.

The Bitcoin Deepa name, "Pearl of Satoshi", the Yaka mask, the දීප glyph and the logos are
trademarks and not covered by the code licence. See
[TRADEMARK](https://github.com/bitcoindeepa/.github/blob/main/TRADEMARK.md) and the
[brand guidelines](https://bitcoindeepa.com/brand).

<br>

<p><sub>Bitcoin Deepa · Colombo, Sri Lanka 🇱🇰 ·
<a href="mailto:hello@bitcoindeepa.com">hello@bitcoindeepa.com</a></sub></p>

[test/README.md]: https://github.com/bitcoindeepa/app-backend/blob/main/test/README.md
