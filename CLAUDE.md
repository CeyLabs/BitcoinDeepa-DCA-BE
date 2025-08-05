# BitcoinDeepa DCA Telegram Mini App Backend

## Project Overview

This is a NestJS-based backend service for the BitcoinDeepa DCA (Dollar Cost Averaging) Telegram Mini App. The application enables users to create Bitcoin DCA subscriptions through Telegram authentication and PayHere payment integration.

**Key Technologies:**
- Framework: NestJS with TypeScript
- Database: PostgreSQL with Knex.js ORM
- Authentication: JWT tokens with Telegram WebApp InitData validation
- Payment Gateway: PayHere (Sri Lankan payment processor)
- Bitcoin Integration: CoinGecko API for real-time BTC prices and DCA calculations
- Time Management: dayjs for date/time operations
- Development: pnpm, ESLint, Prettier

## Architecture & Module Structure

### Core Modules

1. **Auth Module** (`src/modules/auth/`)
   - Telegram WebApp InitData validation using HMAC-SHA256 with timestamp verification (24-hour max age)
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
   - CoinGecko API integration for real-time Bitcoin prices
   - Automatic satoshi calculation for DCA transactions
   - Price caching with configurable TTL (20 seconds default)
   - Support for multiple currencies (LKR, USD, etc.)

9. **Didit KYC Module** (`src/modules/didit/`)
   - KYC (Know Your Customer) verification integration via Didit API
   - Verification session management and webhook handling
   - ID verification, liveness detection, face matching, and AML screening
   - Automatic user KYC status updates via webhooks

### Database Schema

**Tables:**
- `package`: Subscription packages (UUID PK, name, frequency, amount, currency)
- `user`: User profiles (Telegram ID as PK, personal info, address, KYC status and verification data)
- `subscription`: Active subscriptions (PayHere sub ID as PK, user ID, package ID, is_active)
- `transaction`: Payment records (PayHere pay ID as PK, subscription ID, status, Bitcoin price, satoshis purchased, timestamps)

**Relationships:**
- Users → Subscriptions (1:many)
- Packages → Subscriptions (1:many)
- Subscriptions → Transactions (1:many)

## Development Workflow

### Setup Commands
```bash
# Install dependencies
pnpm install

# Database setup
pnpm migrate          # Run migrations
pnpm seed            # Seed initial data
pnpm db:reset        # Full database reset (rollback + migrate + seed)

# Environment setup
cp .env.template .env  # Configure environment variables
```

### Development Commands
```bash
# Start development server
pnpm start:dev       # Watch mode

# Production
pnpm start:prod      # Production mode

# Code quality
pnpm lint           # ESLint with auto-fix
pnpm prettier       # Format code

# Database operations
pnpm migrate:rollback  # Rollback all migrations
```

## Environment Variables

### Required Configuration
```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname

# Telegram Authentication
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
JWT_SECRET=your_jwt_secret_key
ENABLE_AUTH=true  # Set to 'false' for development (bypasses auth)

# PayHere Integration
PAYHERE_MERCHANT_ID=your_merchant_id
PAYHERE_MERCHANT_SECRET=your_merchant_secret
PAYHERE_APP_ID=your_app_id
PAYHERE_APP_SECRET=your_app_secret
PAYHERE_BASE_URL=https://sandbox.payhere.lk  # or production URL

# Bitcoin DCA Configuration
COINGECKO_API_KEY=your_coingecko_pro_api_key  # Optional, for better rate limits
ENABLE_BITCOIN_TRACKING=true  # Set to 'false' to disable Bitcoin calculations
BITCOIN_PRICE_CACHE_TTL=20  # Cache duration in seconds (default: 20)

# Didit KYC Integration
DIDIT_API_KEY=your_didit_api_key  # Required for KYC verification
DIDIT_BASE_URL=https://api.didit.me  # Didit API base URL (sandbox: https://sandbox.api.didit.me)
DIDIT_WEBHOOK_SECRET=your_webhook_secret  # Optional, for webhook signature verification
BASE_URL=https://your-app-domain.com  # Your application base URL for webhook callbacks

# Server
PORT=3000
```

## API Endpoints Reference

**Authentication Coverage:**
- All endpoints requiring user context are protected with `@UseGuards(ConditionalAuthGuard)`
- Public endpoints: Package listing, PayHere webhook, Telegram authentication
- Protected endpoints: User creation, subscription management, transaction history

### Authentication
- `POST /auth/telegram` - Validate Telegram InitData, return JWT token

### User Management
- `POST /user` - Create user profile (authenticated)
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

### Transactions
- `POST /transaction/payhere-webhook` - PayHere webhook handler (public)
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
- Webhook signatures should be verified when `DIDIT_WEBHOOK_SECRET` is configured
- Handle various verification statuses: pending, verified, rejected, expired
- Store Didit session IDs for tracking verification progress
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

### Database Migrations
1. Create migration file: `npx knex migrate:make migration_name`
2. Implement `up()` and `down()` methods
3. Run migration: `pnpm migrate`
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
│   └── knex/             # Database connection
├── migrations/           # Database schema migrations
└── seeds/               # Initial data seeding
```

## Key Interfaces & Types

```typescript
// Authentication
interface JwtPayload {
  user_id: string;
  telegram_id: string;
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
- Telegram InitData validation requires proper HMAC-SHA256 verification with 24-hour timestamp limit
- Replay attack protection: InitData must be less than 24 hours old
- Production environments always enforce authentication regardless of ENABLE_AUTH setting
- Database uses UUID for packages, string IDs for users (Telegram ID)
- All timestamps use PostgreSQL's automatic timestamp handling