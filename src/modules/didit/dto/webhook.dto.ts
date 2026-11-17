import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
}
