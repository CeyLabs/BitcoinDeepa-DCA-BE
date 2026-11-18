import { plainToInstance } from 'class-transformer';
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

const isProduction = (env: EnvironmentVariables) =>
  env.NODE_ENV === 'production';

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

  @IsOptional()
  @IsInt()
  @Min(1)
  BTC_PRICE_CACHE_TTL?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  USD_LKR_CACHE_TTL?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REDIS_TTL_DEFAULT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  BITCOINDEEPA_TIMEOUT?: number;

  // Sell flow (CeyPay aggregator off-ramp)
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

  @IsOptional()
  @IsInt()
  @Min(1)
  SELL_MIN_SATS?: number;

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
  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  CEYPAY_WEBHOOK_PUBLIC_KEY?: string;

  @ValidateIf(isProduction)
  @IsUrl({ require_tld: false })
  CEYPAY_WEBHOOK_URL?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  CEYPAY_TIMEOUT?: number;

  // Cloudflare R2 (bank statements, private bucket)
  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  R2_ACCOUNT_ID?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  R2_ACCESS_KEY_ID?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  R2_SECRET_ACCESS_KEY?: string;

  @ValidateIf(isProduction)
  @IsString()
  @IsNotEmpty()
  R2_BUCKET?: string;

  // Optional S3-compatible endpoint override (local MinIO / tests)
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  R2_ENDPOINT?: string;

  // Admin dashboard base URL, used in Telegram alert links
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

  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }
  return validated;
}
