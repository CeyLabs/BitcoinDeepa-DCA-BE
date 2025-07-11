import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as dayjs from 'dayjs';
import { DatabaseLoggerService } from '../knex/database-logger.service';

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
  user_id: string;
  telegram_id?: string;
  username?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly dbLogger: DatabaseLoggerService,
  ) {}

  async verifyTelegramInitData(initData: string, botToken: string): Promise<boolean> {
    try {
      const parsed = new URLSearchParams(initData);
      const hash = parsed.get('hash');
      const authDate = parsed.get('auth_date');

      if (!hash || !authDate) {
        await this.dbLogger.warn('Missing hash or auth_date in Telegram init data verification');
        return false;
      }

      // Validate timestamp to prevent replay attacks
      const authTimestamp = parseInt(authDate, 10);
      if (isNaN(authTimestamp)) {
        await this.dbLogger.warn('Invalid timestamp format in Telegram init data');
        return false;
      }

      const authTime = dayjs.unix(authTimestamp);
      const currentTime = dayjs();
      const maxAge = 24; // 24 hours

      if (currentTime.diff(authTime, 'hour') > maxAge) {
        await this.dbLogger.warn(`Expired Telegram auth data - age: ${currentTime.diff(authTime, 'hour')} hours (max: ${maxAge})`);
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
        await this.dbLogger.warn('Hash verification failed for Telegram init data');
      }

      return isValid;
    } catch (error) {
      await this.dbLogger.error(`Exception during Telegram init data verification: ${error.message}`);
      return false;
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
    await this.dbLogger.info(`JWT token generated for user: ${payload.telegram_id}`);
    return token;
  }

  async verifyJwt(token: string): Promise<JwtPayload> {
    try {
      const payload = this.jwtService.verify(token);
      await this.dbLogger.info(`JWT token verified for user: ${payload.telegram_id}`);
      return payload;
    } catch (error) {
      await this.dbLogger.warn(`JWT verification failed: ${error.message}`);
      throw error;
    }
  }
}
