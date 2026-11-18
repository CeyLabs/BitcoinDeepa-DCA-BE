import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export const CEYPAY_WEBHOOK_EVENTS = [
  'payment.completed',
  'payment.failed',
] as const;

/**
 * CeyPay aggregator off-ramp webhook. The signature is checked against the
 * raw body, so stripping unknown fields here doesn't affect it.
 */
export class CeyPayWebhookDto {
  @IsIn(CEYPAY_WEBHOOK_EVENTS)
  event!: (typeof CEYPAY_WEBHOOK_EVENTS)[number];

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
