import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** PayHere notify_url payload (form-urlencoded, all values are strings). */
export class PayHereNotificationDto {
  @IsString()
  @IsNotEmpty()
  merchant_id: string;

  @IsString()
  @IsNotEmpty()
  order_id: string;

  @IsString()
  @IsNotEmpty()
  payment_id: string;

  @IsString()
  @IsNotEmpty()
  subscription_id: string;

  @IsString()
  @IsNotEmpty()
  payhere_amount: string;

  @IsString()
  @IsNotEmpty()
  payhere_currency: string;

  @IsString()
  @IsNotEmpty()
  status_code: string;

  @IsString()
  @IsNotEmpty()
  md5sig: string;

  @IsOptional()
  @IsString()
  custom_1?: string; // user_id

  @IsOptional()
  @IsString()
  custom_2?: string; // package_id

  // Recurring API extras
  // AUTHORIZATION_SUCCESS | AUTHORIZATION_FAILED | RECURRING_INSTALLMENT_SUCCESS |
  // RECURRING_INSTALLMENT_FAILED | RECURRING_COMPLETE | RECURRING_STOPPED
  @IsOptional()
  @IsString()
  message_type?: string;

  // 0: active, -1: cancelled/stopped, 1: completed
  @IsOptional()
  @IsString()
  item_rec_status?: string;
}
