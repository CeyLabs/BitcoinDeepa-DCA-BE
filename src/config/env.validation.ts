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
  ValidateIf,
  validateSync,
} from 'class-validator';

const isProduction = (env: EnvironmentVariables) =>
  env.NODE_ENV === 'production';

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

  @ValidateIf(isProduction)
  @IsUrl({ require_tld: false })
  BETTER_AUTH_URL?: string;

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
