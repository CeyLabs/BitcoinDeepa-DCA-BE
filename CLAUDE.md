# BitcoinDeepa DCA Telegram Mini App Backend

## Project Overview

This is a NestJS-based backend service for the BitcoinDeepa DCA (Dollar Cost Averaging) Telegram Mini App. The application enables users to create Bitcoin DCA subscriptions through Telegram authentication and PayHere payment integration.

**Key Technologies:**
- Framework: NestJS with TypeScript
- Database: PostgreSQL with Knex.js ORM
- Authentication: JWT tokens with Telegram WebApp InitData validation
- Payment Gateway: PayHere (Sri Lankan payment processor)
- Bitcoin Integration: CoinMarketCap API for real-time BTC prices and DCA calculations
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
   - CoinMarketCap API integration for real-time Bitcoin prices
   - Automatic satoshi calculation for DCA transactions
   - Redis price caching: BTC/USD `BTC_PRICE_CACHE_TTL` (300s default), USD/LKR `USD_LKR_CACHE_TTL` (20s default)
   - Support for multiple currencies (LKR, USD, etc.)

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
   - **Pricing:** BTC/LKR = Ceylon Cash BTC/USD (`fx.ceyloncash.com/currency/BTC` `usd_price`, `BitcoinPriceService.getBtcUsdSellPrice()`, cached 30s) × CeyPay's USDT/LKR (cached 30s), rounded down to cents, so our LKR matches what CeyPay pays for the same USDT. Both rates are stored on the order. CoinMarketCap is not used for selling. The whole sale is priced in LKR (`gross_lkr`, rounded down), then the fee `BITCOINDEEPA_SELL_FEE_BASIS_POINTS` comes off it in LKR (`fee_lkr`, rounded up); `amount_lkr` is what the user gets. All sats collected stay with us. Quotes live `SELL_QUOTE_TTL_SECONDS`
   - **Confirm:** commits `QUOTED` → `COLLECTING` first (so a crash after the debit can't roll back to `QUOTED`), then, with no lock held, debits the user via the bot's `POST /api/v1/collect` (`BitcoinDeepaService.collectFunds`, memo `sell:<orderId>` = idempotent), then locks a CeyPay USDT quote sized so CeyPay's `amountLkr` >= ours and creates the off-ramp (`externalRef` = order id, CeyPay dedupes on it). The user always gets the LKR we quoted; CeyPay's USDT numbers are bookkeeping (it pays from our prefunded LKR float)
   - **Statuses** (`sell_order.status`, forward-only conditional updates): `QUOTED` → `COLLECTING` → `SATS_COLLECTED` → `PAYOUT_PENDING` → `COMPLETED`; `QUOTED`/`COLLECTING` → `EXPIRED` (nothing moved); payout failure → `REFUNDING` → `REFUNDED` (full sats back, memo `sell-refund:<id>`); any unknown transfer outcome (collect/refund timeout or 5xx, payout retries exhausted, stuck in `COLLECTING` > 2 min or `REFUNDING` > 5 min) → `NEEDS_REVIEW` + Telegram alert, never retried automatically. A `COMPLETED` webhook for a refunded order alerts (member may have both)
   - **CeyPay webhook** `POST /sell/ceypay-webhook`: ED25519 (`CEYPAY_WEBHOOK_PUBLIC_KEY`) over `X-Webhook-Timestamp` (ms, ±5 min) + raw body. Bound to the order by `externalRef` + `paymentId`. Crons: expire quotes (1 min), retry payout creation with 2^n min backoff up to 5 attempts (30s), poll CeyPay for `PAYOUT_PENDING` older than 10 min (5 min), stuck `COLLECTING`/`REFUNDING` → `NEEDS_REVIEW` (1 min), alert once on a payout pending > 2 h (10 min). Unknown webhook event types are acknowledged and ignored
   - **CeyPay client** (`src/modules/ceypay/`): aggregator API, `x-api-key` (key id) + `x-timestamp` (ms) + `x-signature` = hex HMAC-SHA256 with key `sha256hex(secret)` over `ts + METHOD + path?query + body`. `CeyPayError.outcomeUnknown` = no response/5xx/429
   - **R2** (`src/modules/storage/`): private bucket; statements are only ever reached through 5-minute presigned URLs (bucket CORS must allow PUT from the TMA origin)

### Database Schema

**Tables:**
- `package`: Subscription packages (UUID PK, name, frequency, amount, currency)
- `user`: User profiles (Telegram ID as PK, personal info, address, KYC status and verification data)
- `subscription`: Active subscriptions (PayHere sub ID as PK, user ID, package ID, is_active)
- `transaction`: Payment records (PayHere pay ID as PK, subscription ID, status, Bitcoin price, satoshis purchased, fee tracking, timestamps)
- `user_bank_account`: Payout bank accounts (status PENDING_REVIEW/VERIFIED/REJECTED, statement R2 key, name-match score, reviewer, CeyPay bank id). `user.ceypay_user_id` links the user to CeyPay
- `sell_order`: Sell orders (sats, gross LKR, fee LKR, BTC/LKR rate, promised LKR, CeyPay quote/payment ids, bank ref, status, retries)

**Relationships:**
- Users → Subscriptions (1:many)
- Packages → Subscriptions (1:many)
- Subscriptions → Transactions (1:many)

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
COINMARKETCAP_API_KEY=your_cmc_api_key
ENABLE_BITCOIN_TRACKING=true  # Set to 'false' to disable Bitcoin calculations
BTC_PRICE_CACHE_TTL=300  # BTC/USD cache in seconds (default: 300)
USD_LKR_CACHE_TTL=20  # USD/LKR cache in seconds (default: 20)

# Fee Configuration
PAYHERE_FEE_BASIS_POINTS=100  # Payment processor fee (1 bp = 0.01%)
BITCOINDEEPA_FEE_BASIS_POINTS=100  # Platform fee

# Didit KYC Integration
DIDIT_API_KEY=your_didit_api_key  # Required for KYC verification
DIDIT_BASE_URL=https://verification.didit.me  # Didit API base URL (v3 sessions API)
DIDIT_WEBHOOK_SECRET=your_webhook_secret  # Required in production; optional in dev
DIDIT_CALLBACK_BASE_URL=https://your-app-domain.com  # Your application base URL for webhook callbacks

# Sell flow (required in production)
BITCOINDEEPA_SELL_FEE_BASIS_POINTS=100  # taken off the LKR amount
SELL_QUOTE_TTL_SECONDS=60
SELL_MIN_SATS=1000
CEYPAY_API_URL=https://api.ceypay.io
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
- `GET /admin/transactions?page=&pageSize=10|20|50|100&status=&from=&to=&q=` - Paginated transactions, newest first, with member and plan. `from`/`to` are inclusive YYYY-MM-DD days in Sri Lanka time; `q` matches payment id, member id or name. Returns `{ items, total, page, pageSize, pageCount }`
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

### Transactions
- `POST /transaction/payhere-webhook` - PayHere webhook handler (public, MD5-signed)
- `POST /transaction/reset-retry-count/:paymentId` - Re-enable settlement for one payment after checking it on BitcoinDeepa (internal, requires `x-admin-key`)
- `GET /transaction/list` - Get user's transaction history with Bitcoin data (authenticated)
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
- Errors: `errorMessage(error)` from `src/common/error-message.ts`.
- Caching: `redisService.getOrSet(key, ttlSeconds, loader)` (null results aren't cached).
- Telegram ops log: `telegramLoggerService.trackAction(action, user, fn)` posts the action, runs `fn`, and reacts on success.
- Users: `userService.getUserOrThrow(id)` throws 404.
- DB pool settings live only in `knexfile.ts`.

### Configuration
- `ConfigModule.forRoot({ isGlobal: true, validate })` loads `.env` and validates it at startup (`src/config/env.validation.ts`). Add new env vars there; the app refuses to boot on missing/invalid values.
- Production additionally requires `TELEGRAM_BOT_TOKEN`, `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET`, `DIDIT_WEBHOOK_SECRET`, and the CeyPay + R2 sell-flow variables.
- `app.enableShutdownHooks()` is on, so `onModuleDestroy` (DB pool, Redis) runs on SIGTERM.

### Database Migrations
1. Create migration file: `npx knex migrate:make migration_name`
2. Implement `up()` and `down()` methods
3. Run migration: `bun run migrate`
4. Create corresponding seed file if needed

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
- Settlement stops retrying (and alerts) when a BitcoinDeepa transfer times out, since it may have gone through.

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