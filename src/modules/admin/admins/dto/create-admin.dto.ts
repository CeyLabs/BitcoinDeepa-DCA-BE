import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Same minimum as Better Auth's minPasswordLength (server-side createUser skips it). */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAdminDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(MIN_ADMIN_PASSWORD_LENGTH)
  @MaxLength(128)
  password!: string;
}
