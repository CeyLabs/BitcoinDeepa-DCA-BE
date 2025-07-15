import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { AuthService, JwtPayload } from './auth.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';

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
  constructor(
    private readonly authService: AuthService,
    private readonly dbLogger: DatabaseLoggerService,
  ) {}

  @Post('telegram')
  async validateTelegramAuth(
    @Body() body: TelegramAuthDto,
  ): Promise<AuthResponse> {
    const { initData } = body;

    // Get bot token from environment variable
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      await this.dbLogger.error(
        'Bot token not configured - authentication failed',
      );
      throw new UnauthorizedException('Bot token not configured');
    }

    // Verify the init data
    const isValid = await this.authService.verifyTelegramInitData(
      initData,
      botToken,
    );
    if (!isValid) {
      await this.dbLogger.warn(
        'Invalid Telegram init data provided during authentication',
      );
      throw new UnauthorizedException('Invalid Telegram init data');
    }

    // Parse the init data to extract user information
    const parsedData = this.authService.parseTelegramInitData(initData);
    if (!parsedData || !parsedData.user) {
      await this.dbLogger.warn('Invalid user data in Telegram init data');
      throw new UnauthorizedException('Invalid user data in init data');
    }

    // Parse user object from the user string
    let userData: TelegramUser;
    try {
      userData = JSON.parse(parsedData.user) as TelegramUser;
    } catch {
      await this.dbLogger.warn(
        'Invalid user data format in Telegram authentication',
      );
      throw new UnauthorizedException('Invalid user data format');
    }

    // Generate JWT payload
    const payload: JwtPayload = {
      user_id: userData.id.toString(),
      telegram_id: userData.id.toString(),
      username: userData.username,
    };

    // Generate JWT token
    const token = await this.authService.generateJwt(payload);

    await this.dbLogger.info(
      `Successful Telegram authentication for user: ${userData.id} (${userData.username || 'no username'})`,
    );

    return {
      token,
      user: {
        telegram_id: userData.id.toString(),
        username: userData.username,
      },
    };
  }
}
