import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

/** The events we act on; others are acknowledged and ignored */
export const CEYPAY_WEBHOOK_EVENTS = [
  'payment.completed',
  'payment.failed',
] as const;
export type CeyPayWebhookEvent = (typeof CEYPAY_WEBHOOK_EVENTS)[number];

/**
 * CeyPay aggregator off-ramp webhook. The signature is checked against the
 * raw body, so stripping unknown fields here doesn't affect it.
 */
export class CeyPayWebhookDto {
  // Any string: a new event type must not fail validation (400) before the
  // signature is even checked, or CeyPay would keep retrying it
  @IsString()
  @IsNotEmpty()
  event!: string;

  @IsUUID('loose')
  paymentId!: string;

  /** Our sell_order id */
  @IsUUID('loose')
  externalRef!: string;

  @IsOptional()
  @IsString()
  bankRef?: string | null;

  @IsOptional()
  @IsString()
  failureReason?: string | null;
}
