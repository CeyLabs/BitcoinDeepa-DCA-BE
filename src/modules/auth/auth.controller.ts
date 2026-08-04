import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { AuthService, JwtPayload, TelegramWidgetAuthDto } from './auth.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import { UserService } from '../user/user.service';

const MAX_AUTH_AGE_SECONDS = 86400; // 1 day

interface TelegramAuthDto {
  initData: string;
}

interface AuthResponse {
  token: string;
  user: {
    telegram_id?: string;
    username?: string;
  };
  isRegistered: boolean;
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
    private readonly userService: UserService,
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

    const telegramId = userData.id.toString();
    const isRegistered = await this.userService.userExists(telegramId);

    // Auto-register/refresh the user's basic profile from Telegram data
    await this.userService.upsertTelegramUser({
      id: telegramId,
      first_name: userData.first_name || 'Telegram User',
      last_name: userData.last_name,
    });

    // Generate JWT payload
    const payload: JwtPayload = {
      id: telegramId,
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
        telegram_id: telegramId,
        username: userData.username,
      },
      isRegistered,
    };
  }

  @Post('telegram-widget')
  async validateTelegramWidgetAuth(
    @Body() body: TelegramWidgetAuthDto,
  ): Promise<AuthResponse> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      await this.dbLogger.error(
        'Bot token not configured - widget authentication failed',
      );
      throw new UnauthorizedException('Bot token not configured');
    }

    if (!body?.hash) {
      throw new UnauthorizedException('Invalid Telegram widget data');
    }

    const isValid = this.authService.verifyTelegramWidgetHash(body, botToken);
    if (!isValid) {
      await this.dbLogger.warn(
        'Invalid hash provided during Telegram widget authentication',
      );
      throw new UnauthorizedException('Invalid Telegram widget data');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - body.auth_date > MAX_AUTH_AGE_SECONDS) {
      await this.dbLogger.warn(
        `Expired Telegram widget auth data for user: ${body.id}`,
      );
      throw new UnauthorizedException('Login expired, please try again');
    }

    const telegramId = body.id.toString();
    const isRegistered = await this.userService.userExists(telegramId);

    await this.userService.upsertTelegramUser({
      id: telegramId,
      first_name: body.first_name || 'Telegram User',
      last_name: body.last_name,
    });

    const payload: JwtPayload = {
      id: telegramId,
      username: body.username,
    };

    const token = await this.authService.generateJwt(payload);

    await this.dbLogger.info(
      `Successful Telegram widget authentication for user: ${body.id} (${body.username || 'no username'})`,
    );

    return {
      token,
      user: {
        telegram_id: telegramId,
        username: body.username,
      },
      isRegistered,
    };
  }
}
