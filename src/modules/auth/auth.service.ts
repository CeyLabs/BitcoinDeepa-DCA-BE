import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as dayjs from 'dayjs';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { DatabaseLoggerService } from '../knex/database-logger.service';

const TELEGRAM_OIDC_ISSUER = 'https://oauth.telegram.org';
const TELEGRAM_OIDC_JWKS_URL =
  'https://oauth.telegram.org/.well-known/jwks.json';

// jose is ESM-only; this project compiles to CommonJS, so it must be loaded
// via dynamic import() rather than a static import (which tsc would emit as
// a require() and crash with ERR_REQUIRE_ESM).
let telegramJwksPromise: Promise<JWTVerifyGetKey> | null = null;
async function getTelegramJwks(): Promise<JWTVerifyGetKey> {
  if (!telegramJwksPromise) {
    telegramJwksPromise = import('jose').then(({ createRemoteJWKSet }) =>
      createRemoteJWKSet(new URL(TELEGRAM_OIDC_JWKS_URL)),
    );
  }
  return telegramJwksPromise;
}

export interface TelegramInitData {
  query_id?: string;
  user?: string;
  receiver?: string;
  chat?: string;
  chat_type?: string;
  chat_instance?: string;
  start_param?: string;
  can_send_after?: string;
  auth_date: string;
  hash: string;
}

export interface JwtPayload {
  id: string;
  username?: string;
}

export interface TelegramOidcAuthDto {
  id_token: string;
}

// Claims Telegram puts in the id_token — see
// https://core.telegram.org/bots/telegram-login#user-data-structure
export interface TelegramOidcClaims extends JWTPayload {
  id: number;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  picture?: string;
  phone_number?: string;
  phone_number_verified?: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly dbLogger: DatabaseLoggerService,
  ) {}

  async verifyTelegramInitData(
    initData: string,
    botToken: string,
  ): Promise<boolean> {
    try {
      const parsed = new URLSearchParams(initData);
      const hash = parsed.get('hash');
      const authDate = parsed.get('auth_date');

      if (!hash || !authDate) {
        await this.dbLogger.warn(
          'Missing hash or auth_date in Telegram init data verification',
        );
        return false;
      }

      // Validate timestamp to prevent replay attacks
      const authTimestamp = parseInt(authDate, 10);
      if (isNaN(authTimestamp)) {
        await this.dbLogger.warn(
          'Invalid timestamp format in Telegram init data',
        );
        return false;
      }

      const authTime = dayjs.unix(authTimestamp);
      const currentTime = dayjs();
      const maxAge = 24; // 24 hours

      if (currentTime.diff(authTime, 'hour') > maxAge) {
        await this.dbLogger.warn(
          `Expired Telegram auth data - age: ${currentTime.diff(authTime, 'hour')} hours (max: ${maxAge})`,
        );
        return false;
      }

      // Remove 'hash' and sort keys
      parsed.delete('hash');
      const dataCheckString = [...parsed.entries()]
        .map(([key, val]) => `${key}=${val}`)
        .sort()
        .join('\n');

      // Compute HMAC
      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

      const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      const isValid = computedHash === hash;
      if (!isValid) {
        await this.dbLogger.warn(
          'Hash verification failed for Telegram init data',
        );
      }

      return isValid;
    } catch (error) {
      await this.dbLogger.error(
        `Exception during Telegram init data verification: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Verifies a Telegram Login (OIDC) id_token: signature against Telegram's
   * JWKS, issuer, and audience (must match this app's Client ID from
   * BotFather). jwtVerify also rejects expired tokens.
   * https://core.telegram.org/bots/telegram-login#validating-id-tokens
   */
  async verifyTelegramOidcToken(
    idToken: string,
    clientId: string,
  ): Promise<TelegramOidcClaims> {
    try {
      const { jwtVerify } = await import('jose');
      const jwks = await getTelegramJwks();
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: TELEGRAM_OIDC_ISSUER,
        audience: clientId,
      });

      if (typeof payload.id !== 'number') {
        throw new Error('id_token missing numeric "id" claim');
      }

      return payload as TelegramOidcClaims;
    } catch (error) {
      await this.dbLogger.warn(
        `Telegram OIDC id_token verification failed: ${error.message}`,
      );
      throw new UnauthorizedException('Invalid Telegram login token');
    }
  }

  parseTelegramInitData(initData: string): TelegramInitData | null {
    try {
      const parsed = new URLSearchParams(initData);

      return {
        query_id: parsed.get('query_id') || undefined,
        user: parsed.get('user') || undefined,
        receiver: parsed.get('receiver') || undefined,
        chat: parsed.get('chat') || undefined,
        chat_type: parsed.get('chat_type') || undefined,
        chat_instance: parsed.get('chat_instance') || undefined,
        start_param: parsed.get('start_param') || undefined,
        can_send_after: parsed.get('can_send_after') || undefined,
        auth_date: parsed.get('auth_date') || '',
        hash: parsed.get('hash') || '',
      };
    } catch {
      return null;
    }
  }

  async generateJwt(payload: JwtPayload): Promise<string> {
    const token = this.jwtService.sign(payload);
    await this.dbLogger.info(`JWT token generated for user: ${payload.id}`);
    return token;
  }

  async verifyJwt(token: string): Promise<JwtPayload> {
    try {
      const payload = this.jwtService.verify(token);
      await this.dbLogger.info(
        `JWT token verified for user: ${payload.telegram_id}`,
      );
      return payload;
    } catch (error) {
      await this.dbLogger.warn(`JWT verification failed: ${error.message}`);
      throw error;
    }
  }
}
