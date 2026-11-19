import { plainToInstance } from 'class-transformer';
import { createPrivateKey } from 'crypto';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  IsUrl,
  Validate,
  ValidateIf,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';

/** An Ed25519 private key PEM (multi-line, or one line with literal "\n") */
@ValidatorConstraint({ name: 'isEd25519PrivateKeyPem' })
class IsEd25519PrivateKeyPem implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !value) return false;
    try {
      return (
        createPrivateKey(value.replace(/\\n/g, '\n')).asymmetricKeyType ===
        'ed25519'
      );
    } catch {
      return false;
    }
  }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an Ed25519 private key PEM`;
  }
}

/** Set, or required because it's production */
const presentOrProduction =
  (name: keyof EnvironmentVariables) => (env: EnvironmentVariables) =>
    isProduction(env) || !!env[name];

const isProduction = (env: EnvironmentVariables) =>
  env.NODE_ENV === 'production';

/** Selling also needs CeyPay's webhook key and R2: required in production once it is switched on */
const sellRequired = (env: EnvironmentVariables) =>
  isProduction(env) && env.SELL_ENABLED === 'true';

/** A cross-site (SameSite=None) admin cookie is for dev/staging only */
@ValidatorConstraint({ name: 'notNoneInProduction' })
class NotNoneInProduction implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    return !(
      value === 'none' && isProduction(args.object as EnvironmentVariables)
    );
  }
  defaultMessage(): string {
    return "must be 'lax' in production (dashboard and API on one domain)";
  }
}

/**
 * Validated at startup by ConfigModule.forRoot - the app refuses to boot on
 * a missing/invalid value instead of failing later at runtime.
 */
class EnvironmentVariables {
  @IsOptional()
  // 'localhost' is a knexfile environment (local Postgres on port 3009)
  @IsIn(['development', 'production', 'test', 'localhost'])
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  // Auth
  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  ENABLE_AUTH?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  TELEGRAM_BOT_TOKEN?: string;

  // Admin dashboard (Better Auth). Optional in development: Better Auth then
  // uses its built-in dev secret and http://localhost:PORT.
  @ValidateIf(isProduction)
  @IsString()
  @MinLength(32)
  BETTER_AUTH_SECRET?: string;

  // Public URL of this API, e.g. https://api.example.com
  @ValidateIf(isProduction)
  @IsUrl({ require_tld: false, require_protocol: true })
  BASE_URL?: string;

  // Better Auth's URL; defaults to BASE_URL
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  BETTER_AUTH_URL?: string;

  // 'none' lets a dev/staging dashboard on another site (vercel.app vs
  // railway.app) keep its session. Refused in production; Safari still blocks it.
  @IsOptional()
  @IsIn(['lax', 'none'])
  @Validate(NotNoneInProduction)
  ADMIN_COOKIE_SAME_SITE?: string;

  // Comma-separated admin dashboard origin(s), e.g. https://admin.example.com
  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  ADMIN_APP_URL?: string;

  // PayHere
  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  PAYHERE_MERCHANT_ID?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  PAYHERE_MERCHANT_SECRET?: string;

  // OAuth app: settlement confirms every payment with PayHere before paying
  // out, and plan cancellation goes through the same API.
  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  PAYHERE_APP_ID?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  PAYHERE_APP_SECRET?: string;

  @IsOptional()
  @IsIn(['sandbox', 'live'])
  PAYHERE_ENV?: string;

  // Didit - unsigned KYC webhooks must never be accepted in production
  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  DIDIT_WEBHOOK_SECRET?: string;

  // Bitcoin / fees
  @IsOptional()
  @IsIn(['true', 'false'])
  ENABLE_BITCOIN_TRACKING?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  PAYHERE_FEE_BASIS_POINTS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  BITCOINDEEPA_FEE_BASIS_POINTS?: number;

  // CoinMarketCap 24h change cache (display only), seconds
  @IsOptional()
  @IsInt()
  @Min(1)
  BTC_PRICE_CACHE_TTL?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REDIS_TTL_DEFAULT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  BITCOINDEEPA_TIMEOUT?: number;

  // BitcoinDeepa bot wallet API (Ed25519-signed). Required in production:
  // without them every payout stops (HMAC is gone, there is no fallback).
  // A key that is set must parse as Ed25519 in any environment.
  @ValidateIf(isProduction)
  @IsUrl({ require_tld: false, require_protocol: true })
  BITCOINDEEPA_API_URL?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  BITCOINDEEPA_WALLET_ID?: string;

  // One Ed25519 key signs both the send API and P2P
  @ValidateIf(presentOrProduction('BITCOINDEEPA_PRIVATE_KEY_PEM'))
  @Validate(IsEd25519PrivateKeyPem)
  BITCOINDEEPA_PRIVATE_KEY_PEM?: string;

  // P2P sends (users' own wallets, relayed to the bot's /api/v1/p2p). On by
  // default; P2P_ENABLED=false switches it off (/p2p/* answers 503). Signed
  // with the same BITCOINDEEPA_PRIVATE_KEY_PEM (also the bot's
  // api.p2p.service_public_key).
  @IsOptional()
  @IsIn(['true', 'false'])
  P2P_ENABLED?: string;

  // Shared secret the bot sends as X-Callback-Secret on its deposit callback.
  // Optional until the bot supports it; when set, the callback requires it.
  @IsOptional()
  @IsString()
  @MinLength(16)
  BITCOINDEEPA_CALLBACK_SECRET?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  BITCOINDEEPA_SEND_TIMEOUT?: number;

  // One-time buys (whole LKR). Defaults in buy.service.ts.
  @IsOptional()
  @IsInt()
  @Min(1)
  BUY_MIN_LKR?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  BUY_MAX_LKR?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  BUY_DAILY_MAX_LKR?: number;

  // Minutes a checkout can be paid; later payments are held for review
  @IsOptional()
  @IsInt()
  @Min(1)
  BUY_ORDER_TTL_MINUTES?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  BUY_LINKS_PER_HOUR?: number;

  // How old a logged BTC/LKR rate may be and still price a payment when the
  // live price is down (0 = never use it). Capped (15 min, see
  // MAX_FALLBACK_MAX_AGE_SECONDS): the payment is settled automatically, so a
  // typo must not price it at an hours-old rate.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(900)
  EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS?: number;

  // Sell flow (CeyPay aggregator off-ramp). Off unless SELL_ENABLED=true:
  // the sell and bank-account endpoints answer 503 and its crons don't run.
  @IsOptional()
  @IsIn(['true', 'false'])
  SELL_ENABLED?: string;

  // Pretend the bot debited the sats (its collect endpoint isn't built yet).
  // Sandbox CeyPay only, so fake sats can never be paid out for real.
  @IsOptional()
  @IsIn(['true', 'false'])
  BITCOINDEEPA_COLLECT_MOCK?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  BITCOINDEEPA_SELL_FEE_BASIS_POINTS?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600)
  SELL_QUOTE_TTL_SECONDS?: number;

  // How long a confirmed sale waits for the user to approve the payment
  // (default 300). At most the bot's own 15-minute request expiry.
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(900)
  SELL_COLLECT_WINDOW_SECONDS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  SELL_MIN_SATS?: number;

  // Largest single sale (default 5,000,000 sats)
  @IsOptional()
  @IsInt()
  @Min(1)
  SELL_MAX_SATS?: number;

  // Most a member can sell in a rolling 24 hours (default 20,000,000 sats)
  @IsOptional()
  @IsInt()
  @Min(1)
  SELL_DAILY_MAX_SATS?: number;

  // CeyPay's USDT/LKR rate prices every buy, DCA payment and sale, so its API
  // is required in production even with selling off
  @ValidateIf(isProduction)
  @IsUrl({ require_tld: false })
  CEYPAY_API_URL?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  CEYPAY_API_KEY_ID?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  CEYPAY_API_SECRET?: string;

  // ED25519 public key (PEM or base64 DER) CeyPay signs webhooks with
  @ValidateIf(sellRequired)
  @IsString()
  @IsNotEmpty()
  CEYPAY_WEBHOOK_PUBLIC_KEY?: string;

  // Defaults to BASE_URL + /sell/ceypay-webhook
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  CEYPAY_WEBHOOK_URL?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  CEYPAY_TIMEOUT?: number;

  // Cloudflare R2 (bank statements, private bucket)
  @ValidateIf(sellRequired)
  @IsString()
  @IsNotEmpty()
  R2_ACCOUNT_ID?: string;

  @ValidateIf(sellRequired)
  @IsString()
  @IsNotEmpty()
  R2_ACCESS_KEY_ID?: string;

  @ValidateIf(sellRequired)
  @IsString()
  @IsNotEmpty()
  R2_SECRET_ACCESS_KEY?: string;

  @ValidateIf(sellRequired)
  @IsString()
  @IsNotEmpty()
  R2_BUCKET?: string;

  // Optional S3-compatible endpoint override (local MinIO / tests)
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  R2_ENDPOINT?: string;

  // Admin dashboard URL for Telegram alert links; defaults to the first
  // ADMIN_APP_URL origin
  @IsOptional()
  @IsUrl({ require_tld: false })
  ADMIN_DASHBOARD_URL?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  const problems = errors.map(
    (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
  );
  if (
    validated.BITCOINDEEPA_COLLECT_MOCK === 'true' &&
    !/sandbox/i.test(validated.CEYPAY_API_URL ?? '')
  ) {
    problems.push(
      'BITCOINDEEPA_COLLECT_MOCK: only allowed with the CeyPay sandbox (CEYPAY_API_URL)',
    );
  }

  if (problems.length > 0) {
    const details = problems.join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }
  return validated;
}
