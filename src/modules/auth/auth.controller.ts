import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { AuthService, JwtPayload } from './auth.service';
import { TelegramAuthDto, TelegramOidcAuthDto } from './dto/telegram-auth.dto';
import { UserService } from '../user/user.service';
import { WebIdTokenStore } from './web-id-token.store';
import { isP2pEnabled } from '../../common/p2p-enabled';

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
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
    private readonly webIdTokens: WebIdTokenStore,
  ) {}

  @Post('telegram')
  async validateTelegramAuth(
    @Body() body: TelegramAuthDto,
  ): Promise<AuthResponse> {
    const { initData } = body;

    // Get bot token from environment variable
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      this.logger.error('Bot token not configured - authentication failed');
      throw new UnauthorizedException('Bot token not configured');
    }

    // Verify the init data
    const isValid = this.authService.verifyTelegramInitData(initData, botToken);
    if (!isValid) {
      this.logger.warn(
        'Invalid Telegram init data provided during authentication',
      );
      throw new UnauthorizedException('Invalid Telegram init data');
    }

    // Parse the init data to extract user information
    const parsedData = this.authService.parseTelegramInitData(initData);
    if (!parsedData || !parsedData.user) {
      this.logger.warn('Invalid user data in Telegram init data');
      throw new UnauthorizedException('Invalid user data in init data');
    }

    // Parse user object from the user string
    let userData: TelegramUser;
    try {
      userData = JSON.parse(parsedData.user) as TelegramUser;
    } catch {
      this.logger.warn('Invalid user data format in Telegram authentication');
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
    const token = this.authService.generateJwt(payload);

    this.logger.log(
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

  @Post('telegram-oidc')
  async validateTelegramOidcAuth(
    @Body() body: TelegramOidcAuthDto,
  ): Promise<AuthResponse> {
    const clientId = process.env.TELEGRAM_OIDC_CLIENT_ID;
    if (!clientId) {
      this.logger.error(
        'Telegram OIDC client ID not configured - authentication failed',
      );
      throw new UnauthorizedException('Telegram login not configured');
    }

    if (!body?.id_token) {
      throw new UnauthorizedException('Invalid Telegram login data');
    }

    const claims = await this.authService.verifyTelegramOidcToken(
      body.id_token,
      clientId,
    );

    const telegramId = claims.id.toString();
    const isRegistered = await this.userService.userExists(telegramId);

    // P2P sends from the web forward this login to the bot, so keep it
    // server-side (a fresh login before a send replaces it)
    if (isP2pEnabled() && typeof claims.iat === 'number') {
      await this.webIdTokens.save(telegramId, body.id_token, claims.iat);
    }

    await this.userService.upsertTelegramUser({
      id: telegramId,
      first_name: claims.given_name || claims.name || 'Telegram User',
      last_name: claims.family_name,
    });

    const payload: JwtPayload = {
      id: telegramId,
      username: claims.preferred_username,
    };

    const token = this.authService.generateJwt(payload);

    this.logger.log(
      `Successful Telegram OIDC authentication for user: ${claims.id} (${claims.preferred_username || 'no username'})`,
    );

    return {
      token,
      user: {
        telegram_id: telegramId,
        username: claims.preferred_username,
      },
      isRegistered,
    };
  }
}
