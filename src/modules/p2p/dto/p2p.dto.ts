import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Limits mirror the bot's (docs/p2p-api.md): it rejects anything else with
// a 400, and unknown fields with invalid_json, so only these are forwarded.

export class P2pResolveDto {
  /** A Bitcoin Deepa @username ("@" optional, any case) */
  @IsString()
  @Length(1, 64)
  to!: string;
}

export class P2pSendDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  to_telegram_id!: number;

  /** Sats */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_100_000_000_000_000)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  memo?: string;

  /** A new UUID per payment, reused on every retry of that payment */
  @IsString()
  @Length(8, 128)
  idempotency_key!: string;
}

export class P2pInitDto {
  /** Recorded like a /start payload, for new bot users only */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
    message: 'referral_code must be 1-64 letters, digits, _ or -',
  })
  referral_code?: string;
}
