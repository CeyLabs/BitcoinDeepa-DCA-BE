import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Only the fields we use. Unknown fields are stripped by the global
 * ValidationPipe; the HMAC is checked against the raw body, so stripping
 * doesn't affect signature verification.
 */
export class WebhookDto {
  @IsString()
  @IsNotEmpty()
  session_id: string;

  // Kept as a plain string: unknown Didit statuses are logged and ignored
  // rather than rejected (which would make Didit retry forever).
  @IsString()
  @IsNotEmpty()
  status: string;

  @IsOptional()
  @IsString()
  failure_reason?: string;

  /** Same on every retry of one event: used to apply each event once */
  @IsOptional()
  @IsString()
  event_id?: string;

  /** Unix seconds, inside the signed body (unlike the X-Timestamp header) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  timestamp?: number;

  /** Didit's result; on approval it holds the name read from the ID */
  @IsOptional()
  @IsObject()
  decision?: Record<string, unknown>;
}
