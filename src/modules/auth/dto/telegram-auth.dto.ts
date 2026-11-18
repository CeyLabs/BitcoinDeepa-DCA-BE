import { IsNotEmpty, IsString } from 'class-validator';

export class TelegramAuthDto {
  @IsString()
  @IsNotEmpty()
  initData: string;
}

export class TelegramOidcAuthDto {
  @IsString()
  @IsNotEmpty()
  id_token: string;
}
