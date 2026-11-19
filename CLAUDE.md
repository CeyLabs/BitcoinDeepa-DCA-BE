# BitcoinDeepa DCA Telegram Mini App Backend

## Project Overview

This is a NestJS-based backend service for the BitcoinDeepa DCA (Dollar Cost Averaging) Telegram Mini App. The application enables users to create Bitcoin DCA subscriptions through Telegram authentication and PayHere payment integration.

**Key Technologies:**
- Framework: NestJS with TypeScript
- Database: PostgreSQL with Knex.js ORM
- Authentication: JWT tokens with Telegram WebApp InitData validation
- Payment Gateway: PayHere (Sri Lankan payment processor)
- Bitcoin Integration: BTC/LKR = Ceylon Cash BTC/USD × CeyPay USDT/LKR (buy, DCA, sell, wallet)
- Time Management: dayjs for date/time operations
- Development: bun (package manager; app runs on Node), ESLint, Prettier

## Architecture & Module Structure

### Core Modules

1. **Auth Module** (`src/modules/auth/`)
   - Telegram WebApp InitData validation using HMAC-SHA256 (constant-time compare) with timestamp verification (1-hour max age)
   - Telegram Login (OIDC) id_token verified against Telegram's JWKS (RS256, issuer, audience, exp)
   - JWT token generation and verification (7-day expiration)
   - Single guard strategy: `ConditionalAuthGuard` (supports both authenticated and development modes)
   - `@CurrentUser()` decorator for extracting user context
   - Replay attack protection through timestamp validation using dayjs

2. **User Module** (`src/modules/user/`)
   - User profile management and creation
   - Stores personal information linked to Telegram ID

3. **Package Module** (`src/modules/package/`)
   - DCA subscription package management
   - Predefined weekly/monthly plans with different investment amounts

4. **Subscription Module** (`src/modules/subscription/`)
   - User subscription lifecycle management
   - PayHere payment link generation
   - Subscription cancellation via PayHere API

5. **Transaction Module** (`src/modules/transaction/`)
   - PayHere webhook processing and signature validation
   - Transaction status tracking and history
   - MD5-based webhook verification

6. **PayHere Module** (`src/modules/payhere/`)
   - Payment gateway integration service
   - OAuth token management for API access
   - Payment link generation with proper signatures

7. **Knex Module** (`src/modules/knex/`)
   - Database connection management with connection pooling
   - Environment-specific configurations
   - Connection monitoring and keep-alive mechanisms

8. **Bitcoin Price Module** (`src/modules/bitcoin-price/`)
   - One price everywhere: `getBtcLkrRate()` = Ceylon Cash BTC/USD (`fx.ceyloncash.com/currency/BTC` `usd_price`) × CeyPay's USDT/LKR (`getQuote('1')`), rounded down to cents. Redis cache: BTC/USD 30s, USDT/LKR 5 min (each CeyPay fetch is a quote row in its `aggregator_fx_quote`, and the rate only moves every ~10 min). Fetches time out after 3s and a failure is remembered for 10s, so an outage costs one slow call per window. Returns null (never throws) when either is down; callers answer 503 or leave the payment for the backfill cron
   - Automatic satoshi calculation for buys and DCA payments (`calculateSatoshis`, LKR only)
   - CoinMarketCap (`COINMARKETCAP_API_KEY`) is display only: the wallet's `24_hr_change` (`getBitcoin24HrChange()`, cached `BTC_PRICE_CACHE_TTL`, 0 when unavailable). Never use it for a price

9. **Didit KYC Module** (`src/modules/didit/`)
   - KYC (Know Your Customer) verification integration via Didit API
   - Verification session management and webhook handling
   - ID verification, liveness detection, face matching, and AML screening
   - Automatic user KYC status updates via webhooks: `X-Signature` (HMAC of raw body), `X-Timestamp` must be within 5 minutes; `DIDIT_WEBHOOK_SECRET` required in production
   - Sessions API v3 (`/v3/session/`); late `Not Started`/`In Progress` webhooks never overwrite a final KYC result; `Resubmitted` → `IN_PROGRESS`
   - Uses strongly typed KYC status enum for database consistency

10. **Admin Module** (`src/modules/admin/`) - everything behind the admin dashboard. `AdminModule` bundles one Nest module per area: `auth/`, `analytics/`, `transactions/`, `members/`. List endpoints share `common/pagination.ts` (`PaginationQueryDto`, `@SearchQuery()`, `toPage`, `likeEscape`). Add new admin areas as sibling folders and import them in `admin.module.ts`
   - **auth/**: Better Auth (email + password) for the admin dashboard (BitcoinDeepa-Admin-FE), mounted on Express at `/api/admin-auth/*` in `app.setup.ts` (before Nest's body parsers)
   - Tables `admin_user`, `admin_session`, `admin_account`, `admin_verification` (snake_case; mapping in `admin-auth.config.ts`). Separate from the Telegram `user` table; the analytics role has no access
   - Only `role = 'admin'` users can get a session (`databaseHooks.session.create.before`); public sign-up is disabled
   - Create admins with `bun run admin:create --email <email> --name "<name>"` (prod build: `node dist/src/scripts/create-admin.js ...`; password prompted or `ADMIN_PASSWORD`)
   - Protect admin endpoints with `@UseGuards(AdminSessionGuard)` and read the session with `@CurrentAdmin()`
   - better-auth is ESM-only: it's loaded with a real dynamic `import()` (same trick as jose), so never import it statically outside `import type`
   - CORS: origins in `ADMIN_APP_URL` get an exact-match credentialed response; other origins keep `CORS_ORIGIN`, without credentials. Cookies are `SameSite=Lax` (`Secure` in production), so **sign-in only works when the dashboard and the API share a registrable domain** (`admin.<domain>` / `api.<domain>`). A dashboard on another site (a `vercel.app` preview against a `railway.app` API; `*.up.railway.app` and `*.vercel.app` are public suffixes, so even two Railway subdomains are different sites) signs in and then gets 401s. For dev/staging only, `ADMIN_COOKIE_SAME_SITE=none` makes it `SameSite=None; Secure` (HTTPS required; refused in production; Safari still blocks it). Admin requests other than GET/HEAD/OPTIONS must carry an `Origin` from `ADMIN_APP_URL` (CSRF)
   - **bank-reviews/**: admin review of users' payout bank accounts (uses `BankAccountService`)

11. **Bank Account Module** (`src/modules/bank-account/`) - users' payout bank accounts and their admin verification
   - User uploads a statement to R2 via a temporary presigned PUT (`POST /bank-accounts/statement-upload`), then submits the account (`POST /bank-accounts`). The backend `HEAD`s the object (exists, under the user's prefix, PDF/JPEG/PNG, <= 8 MB)
   - Every account starts `PENDING_REVIEW` (one in review/verified per user). `name_match_score` (ported CeyFi `name-match.util.ts`, account name vs **`user.kyc_full_name`**, the name Didit read from the ID) is only a reviewer hint. Never compare against `first_name`/`last_name`: those are the Telegram profile name, which the member controls. If `kyc_full_name` is missing it is fetched from Didit; without it submission is refused (503)
   - Admin approve re-checks KYC is still `APPROVED` (409 otherwise), registers it with CeyPay (aggregator user + bank account) inside the row lock, then sets `VERIFIED`; CeyPay failure leaves it pending (502). Reject needs a reason; the same account can be resubmitted. The user gets a Telegram DM either way
   - `BankVerifiedGuard` (exported) gates anything that pays out to the account. Removing an account is blocked while a sell order on it is in flight

12. **Sell Module** (`src/modules/sell/`) - users sell sats for LKR paid to their verified bank account by CeyPay
   - **Switch:** off unless `SELL_ENABLED=true` (`SellEnabledGuard`, `src/common/sell-enabled.ts`): price, quote, confirm, bank list/upload/submit and admin approve answer 503; order views, the webhook and the crons keep working so in-flight sales finish. CeyPay + R2 env are only required in production when it is on
   - **Limits:** `SELL_MIN_SATS` (1,000), `SELL_MAX_SATS` per sale (5,000,000), `SELL_DAILY_MAX_SATS` per member over a rolling 24h (20,000,000; counts `COUNTED_SELL_STATUSES`). Checked at quote and again at confirm under a lock on the member's `user` row
   - **Bot collect mock:** `BITCOINDEEPA_COLLECT_MOCK=true` treats every debit as done without calling the bot (its collect endpoint isn't built yet) and skips the refund transfer. Env validation refuses it unless `CEYPAY_API_URL` is the sandbox. Collect 5xx = unknown outcome (the contract isn't fixed yet)
   - **Who can sell:** KYC `APPROVED` (`KycVerifiedGuard`) **and** a verified bank account (`BankVerifiedGuard` from bank-account). Both are re-checked at confirm, and the account again at payout time
   - **Pricing:** BTC/LKR from `BitcoinPriceService.getBtcLkrRate()` (see Bitcoin Price Module), so our LKR matches what CeyPay pays for the same USDT. Both rates are stored on the order. The whole sale is priced in LKR (`gross_lkr`, rounded down), then the fee `BITCOINDEEPA_SELL_FEE_BASIS_POINTS` comes off it in LKR (`fee_lkr`, rounded up); `amount_lkr` is what the user gets. All sats collected stay with us. Quotes live `SELL_QUOTE_TTL_SECONDS`
   - **Confirm:** commits `QUOTED` → `COLLECTING` first (so a crash after the debit can't roll back to `QUOTED`), then, with no lock held, debits the user via the bot's `POST /api/v1/collect` (`BitcoinDeepaService.collectFunds`, memo `sell:<orderId>` = idempotent), then locks a CeyPay USDT quote sized so CeyPay's `amountLkr` >= ours and creates the off-ramp (`externalRef` = order id, CeyPay dedupes on it). The update to `SATS_COLLECTED` also counts payout attempt 1 (`retry_count = 1`, `last_retry_at`), so the retry cron can't start a second payout next to confirm's; every later attempt is claimed with the backoff in its `WHERE` (`payoutAttemptDue`). The member's `user` row is locked `FOR NO KEY UPDATE` (a plain `FOR UPDATE` deadlocks with a new quote's insert). The user always gets the LKR we quoted; CeyPay's USDT numbers are bookkeeping (it pays from our prefunded LKR float)
   - **Statuses** (`sell_order.status`, forward-only conditional updates): `QUOTED` → `COLLECTING` → `SATS_COLLECTED` → `PAYOUT_PENDING` → `COMPLETED`; `QUOTED`/`COLLECTING` → `EXPIRED` (nothing moved); payout failure → `REFUNDING` → `REFUNDED` (full sats back, memo `sell-refund:<id>`); any unknown transfer outcome (collect/refund timeout or 5xx, payout retries exhausted, stuck in `COLLECTING` > 2 min or `REFUNDING` > 5 min, `SATS_COLLECTED` with no attempts left > 5 min) → `NEEDS_REVIEW` + Telegram alert, never retried automatically. A payout **refused** after an earlier attempt that got no answer is also `NEEDS_REVIEW`, not refunded: that attempt may have created the payout, and the refusal can come before CeyPay looks at the `externalRef` (our bank-account check, the quote call, its auth guards). `fx_lock_id` is stored just before the off-ramp request, so an order that still has one from an earlier attempt is such an order. A `COMPLETED` webhook for a refunded order alerts (member may have both)
   - **CeyPay webhook** `POST /sell/ceypay-webhook`: ED25519 (`CEYPAY_WEBHOOK_PUBLIC_KEY`) over `X-Webhook-Timestamp` (ms, ±5 min) + raw body. Bound to the order by `externalRef` + `paymentId`. Crons: expire quotes (1 min), retry payout creation with 2^n min backoff up to 5 attempts (30s), poll CeyPay for `PAYOUT_PENDING` older than 10 min (5 min), stuck `COLLECTING`/`REFUNDING`/out-of-attempts `SATS_COLLECTED` → `NEEDS_REVIEW` (1 min), alert once on a payout pending > 2 h (10 min). Unknown webhook event types are acknowledged and ignored
   - **CeyPay client** (`src/modules/ceypay/`): aggregator API, `x-api-key` (key id) + `x-timestamp` (ms) + `x-signature` = hex HMAC-SHA256 with key `sha256hex(secret)` over `ts + METHOD + path?query + body`. `CeyPayError.outcomeUnknown` = no response/5xx/429
   - **R2** (`src/modules/storage/`): private bucket; statements are only ever reached through 5-minute presigned URLs (bucket CORS must allow PUT from the TMA origin)

13. **Buy Module** (`src/modules/buy/`) - one-time BTC buys: one PayHere checkout (no recurrence) for a custom whole-LKR amount
   - `POST /buy/payhere-link` stores a `payhere_order` with `kind = ONE_TIME`, `amount`, `currency` (no package) and returns a one-off checkout link (no `recurrence`/`duration`). KYC + complete profile required; allowed alongside an active subscription
   - **Limits** (`src/common/buy-limits.ts`): `BUY_MIN_LKR` (100), `BUY_MAX_LKR` (100,000) per buy, `BUY_DAILY_MAX_LKR` (250,000) per member over a rolling 24h = paid ONE_TIME PENDING/SUCCESS/CHARGEBACK payments **plus unpaid checkouts that haven't expired** (reserved). Each checkout expires after `BUY_ORDER_TTL_MINUTES` (30); PayHere has no link expiry, so this is ours. `BUY_LINKS_PER_HOUR` (10) checkouts per member per hour, else 429 (counted from `payhere_order`)
   - **Holds:** PayHere can't stop a checkout being paid late or twice, so when a one-time payment becomes SUCCESS the webhook re-checks: paid twice, paid after `expires_at` + 10 min, or the member's 24h total over the limit → `transaction.hold_reason` is set and a Telegram alert goes out. The member's `user` row is locked first (`FOR NO KEY UPDATE`), so two payments arriving together can't both skip these checks. Settlement skips held rows; `POST /transaction/release-hold/:paymentId` (`x-admin-key`) releases one (or refund it in PayHere). The order view shows `held: true`
   - Same fees as subscriptions (`src/common/buy-fees.ts`, used by the webhook too). The webhook, pricing, backfill and settlement are shared: a notification **without `subscription_id`** goes to `handleOneTimeNotification`, which requires a ONE_TIME order and the signed amount/currency to equal the order's; a ONE_TIME order with a `subscription_id` (payer added recurrence) is rejected and alerted; it is never cancelled automatically (`subscription_id` isn't signed, so it could be someone else's) - a human checks it in PayHere and cancels/refunds
   - Settlement confirms one-time payments with PayHere's Retrieval API (`getPaymentsByOrderId`, `GET /merchant/v1/payment/search?order_id=`); memo `One-time BTC purchase (Ref: <payment_id>)`

### Database Schema

**Tables:**
- `package`: Subscription packages (UUID PK, name, frequency, amount, currency)
- `user`: User profiles (Telegram ID as PK, personal info, address, KYC status and verification data)
- `subscription`: Active subscriptions (PayHere sub ID as PK, user ID, package ID, is_active)
- `transaction`: Payment records (PayHere pay ID as PK, `kind` RECURRING/ONE_TIME, `user_id` (owner - read paths, settlement and admin use this, not the subscription), subscription ID (recurring only), `payhere_order_id` (one-time only), status, Bitcoin price, satoshis purchased, fee tracking, timestamps)
- `payhere_order`: Every checkout we start (order_id → user; `kind`; package for RECURRING, amount + currency for ONE_TIME)
- `user_bank_account`: Payout bank accounts (status PENDING_REVIEW/VERIFIED/REJECTED, statement R2 key, name-match score, reviewer, CeyPay bank id). `user.ceypay_user_id` links the user to CeyPay
- `sell_order`: Sell orders (sats, gross LKR, fee LKR, BTC/LKR rate, promised LKR, CeyPay quote/payment ids, bank ref, status, retries)

**Relationships:**
- Users → Subscriptions (1:many)
- Packages → Subscriptions (1:many)
- Subscriptions → Transactions (1:many, recurring)
- Users → Transactions (1:many, `transaction.user_id`)

## Development Workflow

### Setup Commands
```bash
# Install dependencies
bun install

# Database setup
bun run migrate          # Run migrations
bun run seed            # Seed initial data
bun run db:reset        # Full database reset (rollback + migrate + seed)

# Environment setup
cp .env.template .env  # Configure environment variables
```

### Tests
```bash
bun run test            # unit tests (src/**/*.spec.ts), no dependencies
TEST_DATABASE_URL=postgresql://bd_test:bd_test@localhost:5433/bitcoindeepa_dca \
TEST_REDIS_URL=redis://localhost:6380 \
bun run test:e2e        # e2e against a disposable Postgres/Redis (see test/README.md)
```
- Jest + `@nestjs/testing` + supertest. E2E boots the real `AppModule` via `configureApp()` (`src/app.setup.ts`, shared with `main.ts`) and stubs external services in `test/support/test-app.ts`.
- E2E tests truncate tables and refuse to run against the `.env` database. Put new unit tests next to the code (`*.spec.ts`), new flows in `test/*.e2e-spec.ts`.
- CI: `.github/workflows/test.yml` runs tsc, unit and e2e (Postgres + Redis services) on every PR.

### Development Commands
```bash
# Start development server
bun run start:dev       # Watch mode

# Production
bun run start:prod      # Production mode

# Code quality
bun run lint           # ESLint with auto-fix
bun run prettier       # Format code

# Database operations
bun run migrate:rollback  # Rollback all migrations

# One-off backfills (dry run by default, --execute writes)
bun run backfill:payhere-orders  # bind old subscriptions to their PayHere order_id
bun run backfill:kyc-names       # store the verified ID name for already-approved members
```

## Environment Variables

### Required Configuration
```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname

# Telegram Authentication
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
JWT_SECRET=your_jwt_secret_key  # Required - app refuses to start without it
ADMIN_API_KEY=your_admin_key  # Required for internal endpoints (x-admin-key header)
BETTER_AUTH_SECRET=...  # Admin dashboard auth, >= 32 chars (required in production)
BASE_URL=https://api.example.com  # Public URL of this API (required in production)
BETTER_AUTH_URL=  # Optional, defaults to BASE_URL
ADMIN_APP_URL=https://admin.example.com  # Admin dashboard origin(s), comma-separated (required in production)
ADMIN_COOKIE_SAME_SITE=  # Optional, dev/staging only: 'none' for a dashboard on another site (default lax)
ENABLE_AUTH=true  # Set to 'false' for development (bypasses auth)

# PayHere Integration
PAYHERE_MERCHANT_ID=your_merchant_id
PAYHERE_MERCHANT_SECRET=your_merchant_secret
PAYHERE_APP_ID=your_app_id
PAYHERE_APP_SECRET=your_app_secret
PAYHERE_ENV=sandbox  # or live

# Bitcoin DCA Configuration
ENABLE_BITCOIN_TRACKING=true  # Set to 'false' to disable Bitcoin calculations
COINMARKETCAP_API_KEY=your_cmc_api_key  # wallet 24h change only (display)
BTC_PRICE_CACHE_TTL=300  # 24h change cache in seconds (default: 300)

# Fee Configuration
PAYHERE_FEE_BASIS_POINTS=100  # Payment processor fee (1 bp = 0.01%)
BITCOINDEEPA_FEE_BASIS_POINTS=100  # Platform fee

# Didit KYC Integration
DIDIT_API_KEY=your_didit_api_key  # Required for KYC verification
DIDIT_BASE_URL=https://verification.didit.me  # Didit API base URL (v3 sessions API)
DIDIT_WEBHOOK_SECRET=your_webhook_secret  # Required in production; optional in dev
DIDIT_CALLBACK_BASE_URL=https://your-app-domain.com  # Your application base URL for webhook callbacks

# One-time buys (optional; defaults shown)
BUY_MIN_LKR=100
BUY_MAX_LKR=100000
BUY_DAILY_MAX_LKR=250000
BUY_ORDER_TTL_MINUTES=30
BUY_LINKS_PER_HOUR=10

# Sell flow (required in production)
BITCOINDEEPA_SELL_FEE_BASIS_POINTS=100  # taken off the LKR amount
SELL_QUOTE_TTL_SECONDS=60
SELL_MIN_SATS=1000
CEYPAY_API_URL=https://api.ceypay.io  # CEYPAY_API_* required in production even with selling off (prices buys/DCA)
CEYPAY_API_KEY_ID=ak_live_...  # BitcoinDeepa's CeyPay merchant must be account_type AGGREGATOR
CEYPAY_API_SECRET=sk_live_...
CEYPAY_WEBHOOK_PUBLIC_KEY=...  # ED25519 public key (PEM, or base64 DER)
CEYPAY_WEBHOOK_URL=  # Optional, defaults to BASE_URL/sell/ceypay-webhook
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=...
ADMIN_DASHBOARD_URL=  # Optional, Telegram alert links; defaults to the first ADMIN_APP_URL

# Server
PORT=3000
```

## API Endpoints Reference

**Authentication Coverage:**
- All endpoints requiring user context are protected with `@UseGuards(ConditionalAuthGuard)`
- Public endpoints: Package listing, PayHere webhook, Telegram authentication
- Protected endpoints: User creation, subscription management, transaction history

### Authentication
- `POST /auth/telegram` - Validate Telegram InitData, return JWT token. Also auto-registers/refreshes a minimal user row (`id`, `first_name`, `last_name`) from the Telegram profile.

### User Management
- `POST /user` - Complete profile (email, phone, address, city, country) for the already-registered user (authenticated)
- `GET /user/me` - Get current user profile, including `is_profile_complete` (authenticated)
- `GET /user/exists/:telegramId` - Check if a user has been registered (public)
- `POST /user/kyc/initiate` - Initiate KYC verification process (authenticated)
- `GET /user/kyc/status` - Get current KYC verification status (authenticated)

### Packages
- `GET /package` - List available subscription packages

### Subscriptions
- `GET /subscription/current` - Get user's current subscription (authenticated)
- `POST /subscription/payhere-link` - Generate PayHere payment link (authenticated, **requires KYC verification**)
- `POST /subscription/cancel` - Cancel active subscription (authenticated)

### KYC Verification
- `POST /didit/webhook` - Didit webhook for KYC status updates (public)

### Admin dashboard
- `/api/admin-auth/*` - Better Auth endpoints (`sign-in/email`, `sign-out`, `get-session`, ...)
- `GET /admin/me` - Current admin (admin session cookie)
- `GET /admin/analytics/summary` - Users, KYC, subscriptions and settled SUCCESS-payment totals (LKR, fees, sats), plus `unsettled` (SUCCESS payments whose sats weren't sent: count, LKR, sats)
- `GET /admin/analytics/daily?days=7|30|90` - Zero-filled daily settled LKR, payment count, unsettled LKR and new users (Asia/Colombo days)
- `GET /admin/transactions?page=&pageSize=10|20|50|100&status=&kind=RECURRING|ONE_TIME&from=&to=&q=` - Paginated transactions, newest first, with member, plan (null for one-time buys) and `kind`. `from`/`to` are inclusive YYYY-MM-DD days in Sri Lanka time; `q` matches payment id, member id or name. Returns `{ items, total, page, pageSize, pageCount }`
- `GET /admin/members?page=&pageSize=&kyc=&subscription=active|none&q=` - Paginated members, newest first, with active plan, settled SUCCESS-payment totals (LKR, sats) and unsettled LKR. `q` matches Telegram id, name, email or phone

### Bank accounts
- `GET /bank-accounts/banks` - Supported banks (CeyPay list, cached 1h)
- `GET /bank-accounts` - User's active bank accounts with review status (account number masked)
- `POST /bank-accounts/statement-upload` - `{ contentType: application/pdf|image/jpeg|image/png, size <= 8MB }` → temporary presigned PUT URL + `key` (KYC required)
- `POST /bank-accounts` - `{ bankCode, accountNumber, accountName, statementKey }` → PENDING_REVIEW (KYC required)
- `DELETE /bank-accounts/:id` - Soft delete (409 while a sale on it is in flight)

### Sell (sats → LKR)
- `GET /sell/price` - Live BTC/LKR buying rate, fee, `minSats` and `maxSats` (estimate only)
- `POST /sell/quote` - `{ sats }` → `QUOTED` order (KYC + verified bank account)
- `POST /sell/orders/:id/confirm` - Collect sats and create the CeyPay payout (KYC + verified bank account; 410 if expired)
- `GET /sell/orders`, `GET /sell/orders/:id` - User's sell orders
- `POST /sell/ceypay-webhook` - CeyPay off-ramp result (public, ED25519-signed)
- Admin: `GET /admin/bank-reviews?status=&page=&pageSize=&q=` (default PENDING_REVIEW, oldest first), `GET /admin/bank-reviews/pending-count`, `GET /admin/bank-reviews/:id/statement` (5-min link), `POST /admin/bank-reviews/:id/approve`, `POST /admin/bank-reviews/:id/reject { reason }`

### Buy (one-time)
- `GET /buy/price` - Live BTC/LKR, fee basis points and buy limits (estimate only)
- `POST /buy/payhere-link` - `{ amount_lkr }` (whole LKR) → `{ link, order_id }` (KYC required)
- `GET /buy/orders/:orderId` - The user's one-time order: `AWAITING_PAYMENT` or the payment status, sats, settled

### Transactions
- `POST /transaction/payhere-webhook` - PayHere webhook handler (public, MD5-signed)
- `POST /transaction/reset-retry-count/:paymentId` - Re-enable settlement for one payment after checking it on BitcoinDeepa (internal, requires `x-admin-key`)
- `POST /transaction/release-hold/:paymentId` - Let settlement pay a held one-time buy after a human checked it (internal, requires `x-admin-key`; 404 unless held and unsettled)
- `GET /transaction/list` - Get user's transaction history with Bitcoin data (authenticated)
- `GET /transaction/bot-history?limit=&offset=` - The user's bot transfers (from the bot, paged by its count). Each row gets `purchase_settlement: true` when it is the transfer that settled one of the user's own SUCCESS payments (incoming, memo `... (Ref: <payment id>)`), so the app shows that purchase once
- `GET /transaction/dca-summary` - Get DCA performance summary with total satoshis and average price (authenticated)

## Development Guidelines

### Authentication Patterns
```typescript
// Protect endpoints with conditional auth
@UseGuards(ConditionalAuthGuard)
@Get('protected-endpoint')
async protectedEndpoint(@CurrentUser() user: JwtPayload) {
  // user.id contains Telegram user ID
  // When ENABLE_AUTH=false, mock user is provided
}

// Require KYC verification for sensitive operations
@UseGuards(ConditionalAuthGuard, KycVerifiedGuard)
@RequireKyc()
@Post('kyc-required-endpoint')
async kycRequiredEndpoint(@CurrentUser() user: JwtPayload) {
  // This endpoint requires the user to have completed KYC verification
  // Will return 403 if KYC is not verified with appropriate error message
}
```

### Database Operations
```typescript
// Inject KnexService for database operations
constructor(private readonly knexService: KnexService) {}

// Use transactions for complex operations
const trx = await this.knexService.knex.transaction();
try {
  // Multiple operations
  await trx.commit();
} catch (error) {
  await trx.rollback();
}
```

### PayHere Integration
- Always validate webhook signatures using MD5
- Handle subscription status updates properly
- Use OAuth tokens for API operations
- Test with sandbox environment first

### KYC Integration (Didit)
- KYC verification is required before creating new subscriptions
- Webhook signatures (`X-Signature` + `X-Timestamp`) are always verified when `DIDIT_WEBHOOK_SECRET` is set (missing/stale = 401); in production the secret is required
- Handle various verification statuses: pending, verified, rejected, expired
- Store Didit session IDs for tracking verification progress
- On approval, store the name on the ID in `user.kyc_full_name` (webhook `decision.id_verifications[0]`, else `GET /v3/session/{id}/decision/`); it is cleared when KYC is no longer approved. Members approved before this: `bun run backfill:kyc-names` (dry run; `--execute` writes)
- Use ID verification + liveness detection as minimum requirements

### Error Handling
- Return appropriate HTTP status codes
- Log PayHere webhook failures for debugging
- Handle Telegram auth validation errors gracefully

## Common Development Tasks

### Adding New Authenticated Endpoints
1. Import `ConditionalAuthGuard` and `@CurrentUser` decorator
2. Apply `@UseGuards(ConditionalAuthGuard)` to controller method
3. Use `@CurrentUser() user: JwtPayload` parameter for user context
4. Type every `@Body()` with a class DTO using class-validator decorators (not an interface) - the global `ValidationPipe` (`whitelist`, `transform`) only validates classes and strips unknown fields

### Shared helpers (use these instead of re-writing the pattern)
- Logging: `private readonly logger = new Logger(MyService.name)`. `DatabaseSystemLogger` (set via `app.useLogger`) already writes log/warn/error to the `log` table; `debug`/`verbose` stay console-only. Don't inject `DatabaseLoggerService` in features.
- Development logging (`src/common/dev-logging.ts`, `NODE_ENV=development` only): every call through the default axios instance or global `fetch` (CeyPay, BitcoinDeepa bot, PayHere, Ceylon Cash, CoinMarketCap, Telegram, Didit) is logged with its request and response under context `ExternalAPI` (2xx INFO, 4xx WARN, 5xx/no response ERROR). Headers are never logged; secret-looking keys, query params and Telegram's bot token are redacted; bodies are cut at 4,000 chars; these lines skip the DB `log` table. On Railway the logger writes JSON lines (`level` info/debug/warn/error, all on stdout) so the log view shows badges and filters (`@level:error`, `@context:SettlementService`, `@api:CeyPay`, `@status:500`). `LOG_FORMAT=json|pretty` overrides. Use axios's default instance or `fetch` for new external calls so they're covered.
- Errors: `errorMessage(error)` from `src/common/error-message.ts`.
- Caching: `redisService.getOrSet(key, ttlSeconds, loader)` (null results aren't cached).
- Telegram ops log: `telegramLoggerService.trackAction(action, user, fn)` posts the action, runs `fn`, and reacts on success.
- Users: `userService.getUserOrThrow(id)` throws 404.
- DB pool settings live only in `knexfile.ts`.

### Configuration
- `ConfigModule.forRoot({ isGlobal: true, validate })` loads `.env` and validates it at startup (`src/config/env.validation.ts`). Add new env vars there; the app refuses to boot on missing/invalid values.
- Production additionally requires `TELEGRAM_BOT_TOKEN`, `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET`, `DIDIT_WEBHOOK_SECRET`, the CeyPay API (`CEYPAY_API_URL`, `CEYPAY_API_KEY_ID`, `CEYPAY_API_SECRET`, it prices every buy), and with `SELL_ENABLED=true` the CeyPay webhook key + R2.
- `app.enableShutdownHooks()` is on, so `onModuleDestroy` (DB pool, Redis) runs on SIGTERM.

### Database Migrations
1. Create migration file: `npx knex migrate:make migration_name`
2. Implement `up()` and `down()` methods
3. Run migration: `bun run migrate`
4. Create corresponding seed file if needed
- Production applies pending migrations on startup (`src/utils/run-migrations.ts`, before Nest boots); elsewhere only with `RUN_MIGRATIONS_ON_STARTUP=true` (`false` turns it off in production). Keep each migration compatible with the previous release: it keeps serving while the new one migrates, and a rollback starts an older build against the newer schema.
- Long or non-transactional (`transaction: false`) migrations: run them by hand with the CLI. Killed mid-run, they leave knex's lock set and the app won't start until `npx knex migrate:unlock`.

### PayHere Webhook Testing
1. Use ngrok or similar tool to expose local endpoint
2. Configure PayHere notify_url to point to `/transaction/payhere-webhook`
3. Monitor logs for webhook processing
4. Verify signature validation and transaction updates

### Transaction Status Management
- `SUCCESS`: Payment completed successfully
- `PENDING`: Payment initiated but not confirmed
- `CANCELLED`: Payment cancelled by user
- `FAILED`: Payment failed
- `CHARGEBACK`: Payment reversed

**Webhook rules (PayHere):**
- PayHere's md5sig (and the checkout hash) only cover merchant_id, order_id, amount, currency (and status_code). `custom_1`/`custom_2` are payer-editable and never trusted: `POST /subscription/payhere-link` stores a `payhere_order` row (order_id → user, package), and the webhook creates subscriptions only from that row. Unknown order_ids are rejected with a Telegram alert. Each subscription is bound to its `payhere_order_id`.
- Status transitions: SUCCESS can only become CHARGEBACK, CHARGEBACK is final, nothing goes back to PENDING. Out-of-order notifications are ignored.
- A new subscription is `is_active = true` only if its first payment is SUCCESS; otherwise it is activated by its first SUCCESS.
- `item_rec_status` -1/1 or `message_type` RECURRING_STOPPED/RECURRING_COMPLETE marks the subscription inactive.
- SUCCESS payments saved without BTC price data (price API down) are backfilled by a cron every minute.
- **BitcoinDeepa bot API** (`src/modules/bitcoindeepa/`): every call is Ed25519-signed (`X-Wallet-ID`, `X-Timestamp`, `X-Nonce`, `X-Signature` over `BDB-SEND-ED25519-V1\nMETHOD\nPATH\nQUERY\nTS\nNONCE\nsha256hex(body)`; sign the exact bytes sent, new nonce per call). Env `BITCOINDEEPA_API_URL`, `BITCOINDEEPA_WALLET_ID`, `BITCOINDEEPA_SEND_PRIVATE_KEY_PEM`; `/send` timeout `BITCOINDEEPA_SEND_TIMEOUT` (95s). A 401/403 alerts at once (key/wallet/clock/IP).
- The transfer memo is the bot's idempotency key (unique per payment, same on every retry). A timeout/5xx is an unknown outcome: the next attempt checks the user's bot history for the memo, then resends with the same memo (the bot answers "already completed" if it went through).
- `/send` above the bot's approval threshold answers 202 awaiting approval: `transaction.bot_send_id` holds the bot's id and a 1-min cron polls `/send/status/{id}` (executed = settled; rejected/expired = retries stop + alert). `transaction.settlement_failure` records why the last send failed.
- `POST /transaction/reset-retry-counts` is the bot's callback when the DCA wallet receives sats (empty body). Requires `X-Callback-Secret` when `BITCOINDEEPA_CALLBACK_SECRET` is set (the bot doesn't send one yet). Only `LOW_BALANCE` payments not attempted in the last 2 min: it skips the backoff and allows at most one more attempt (never gives attempts back), throttled to once per 30s (Redis, plus a per-instance fallback).
- Settlement races: the claim also requires `bot_send_id IS NULL` and `hold_reason IS NULL`, and clears `settlement_failure` while the attempt is in flight; post-send writes are guarded by `retry_count = <this attempt>`. A status 404 for an approval stops as `UNKNOWN`; an approval not final after 25h is reported once a day.
- Production requires `BITCOINDEEPA_API_URL`, `BITCOINDEEPA_WALLET_ID` and an Ed25519 `BITCOINDEEPA_SEND_PRIVATE_KEY_PEM` (env validation). `scripts/test-fund-transfer.sh` sends one signed transfer (`DRY_RUN=1` to only sign).
- Settlement re-reads the payment after the PayHere lookup and sends nothing if it is no longer an unheld, unsettled SUCCESS (a chargeback that arrived after the claim); if an earlier send had no answer it still looks for the memo, and alerts if it can't tell. A chargeback arriving during the transfer itself can't be stopped: `markSettled` marks the payment settled and a second alert says the sats were sent.
- **Reminder** (`settlement/review-reminder.service.ts`, every 3 h, once across instances): alerts are sent once and best effort, so this repeats what still waits for a human - sales in `NEEDS_REVIEW` (until their status changes), held one-time buys and SUCCESS payments whose settlement used all attempts (both for 7 days). Items newer than 30 min are left out.
- Money math uses big.js, never floats: `satoshisFor` (sats for an amount, rounded down), `parseAmount` (PayHere's amount string; never `parseFloat`).

### Fee System

The platform implements a dual-fee system with separate payment processor and platform fees using basis points:

**Configuration:**
- Fees are configured via environment variables (each in basis points)
- `PAYHERE_FEE_BASIS_POINTS`: Fee charged by the payment processor (PayHere)
- `BITCOINDEEPA_FEE_BASIS_POINTS`: Platform fee charged by BitcoinDeepa
- 1 basis point (bp) = 0.01%
- Default: 100 basis points = 1% for each fee
- Examples: 250 bps = 2.5%, 500 bps = 5%

**Payment Processors:**
- `PAYHERE`: Default payment processor (Sri Lankan payment gateway)
- `CEYPAY`: enum value on `subscription` only - not used for buying. CeyPay is used for the sell flow's LKR payouts (see Sell Module)

**Fee Calculation:**
```typescript
payment_processor_fee = gross_amount × (payment_processor_fee_bps ÷ 10000)
bitcoindeepa_fee = gross_amount × (bitcoindeepa_fee_bps ÷ 10000)
total_fees = payment_processor_fee + bitcoindeepa_fee
net_amount = gross_amount - total_fees
satoshis_purchased = (net_amount ÷ btc_price) × 100,000,000
```

**Transaction Fee Fields:**
- `payment_processor`: Enum indicating which processor (PAYHERE or CEYPAY)
- `gross_amount`: Original package amount from payment processor
- `payment_processor_fee_basis_points`: Payment processor fee % at transaction time
- `payment_processor_fee_amount`: Calculated payment processor fee in LKR
- `bitcoindeepa_fee_basis_points`: Platform fee % at transaction time
- `bitcoindeepa_fee_amount`: Calculated platform fee in LKR
- `net_amount`: Amount after all fees (used for Bitcoin purchase)
- `satoshis_purchased`: Calculated using net_amount only

**Example:**
- Package amount: 1000 LKR
- Payment processor fee (100 bps = 1%): 10 LKR
- BitcoinDeepa fee (100 bps = 1%): 10 LKR
- Total fees: 20 LKR
- Net amount: 980 LKR
- Bitcoin purchased: 980 LKR worth of satoshis


## File Organization

```
src/
├── main.ts                 # Application entry point
├── app.module.ts          # Root module
├── modules/
│   ├── auth/              # Authentication & guards
│   ├── user/              # User management
│   ├── package/           # Subscription packages
│   ├── subscription/      # Subscription logic
│   ├── transaction/       # Payment processing
│   ├── payhere/          # PayHere integration
│   ├── bank-account/     # Payout bank accounts + admin verification
│   ├── sell/             # Sell sats for LKR (quotes, CeyPay payouts, refunds)
│   ├── ceypay/           # CeyPay aggregator off-ramp client
│   ├── storage/          # Cloudflare R2 (presigned URLs)
│   ├── admin/            # Admin dashboard API: auth/, analytics/, transactions/, members/, bank-reviews/
│   └── knex/             # Database connection
├── migrations/           # Database schema migrations
└── seeds/               # Initial data seeding
```

## Key Interfaces & Types

```typescript
// Authentication
interface JwtPayload {
  id: string; // Telegram user ID
  username?: string;
}

// PayHere Integration
interface PayHereNotificationParams {
  merchant_id: string;
  order_id: string;
  payhere_amount: string;
  payhere_currency: string;
  status_code: string;
  md5sig: string;
}

// Transaction Status
enum Status {
  SUCCESS = 'SUCCESS',
  PENDING = 'PENDING',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
  CHARGEBACK = 'CHARGEBACK'
}
```

## Development Notes

- When `ENABLE_AUTH=false`, all protected endpoints use mock user data (development only)
- PayHere webhooks must be publicly accessible (no authentication)
- Telegram InitData validation requires proper HMAC-SHA256 verification with 1-hour timestamp limit
- Replay attack protection: InitData must be less than 1 hour old
- Production environments always enforce authentication regardless of ENABLE_AUTH setting
- Database uses UUID for packages, string IDs for users (Telegram ID)
- All timestamps use PostgreSQL's automatic timestamp handling