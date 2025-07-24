import { IsEmail, IsString, IsNotEmpty, Length, Matches } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 50)
  first_name: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 50)
  last_name: string;

  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\+94\d{9}$/, {
    message: 'Please provide a valid phone number (e.g., +94771234567)'
  })
  phone: string;

  @IsString()
  @IsNotEmpty()
  @Length(5, 200)
  address: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 50)
  city: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 50)
  country: string;
}