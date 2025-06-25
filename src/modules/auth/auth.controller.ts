import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { AuthService, JwtPayload } from './auth.service';

interface TelegramAuthDto {
  initData: string;
}

interface AuthResponse {
  token: string;
  user: {
    telegram_id?: string;
    username?: string;
  };
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('telegram')
  validateTelegramAuth(@Body() body: TelegramAuthDto): AuthResponse {
    const { initData } = body;

    // Get bot token from environment variable
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new UnauthorizedException('Bot token not configured');
    }

    // Verify the init data
    const isValid = this.authService.verifyTelegramInitData(initData, botToken);
    if (!isValid) {
      throw new UnauthorizedException('Invalid Telegram init data');
    }

    // Parse the init data to extract user information
    const parsedData = this.authService.parseTelegramInitData(initData);
    if (!parsedData || !parsedData.user) {
      throw new UnauthorizedException('Invalid user data in init data');
    }

    // Parse user object from the user string
    let userData: TelegramUser;
    try {
      userData = JSON.parse(parsedData.user) as TelegramUser;
    } catch {
      throw new UnauthorizedException('Invalid user data format');
    }

    // Generate JWT payload
    const payload: JwtPayload = {
      user_id: userData.id.toString(),
      telegram_id: userData.id.toString(),
      username: userData.username,
    };

    // Generate JWT token
    const token = this.authService.generateJwt(payload);

    return {
      token,
      user: {
        telegram_id: userData.id.toString(),
        username: userData.username,
      },
    };
  }
}
