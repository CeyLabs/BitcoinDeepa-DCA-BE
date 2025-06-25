import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';

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
  constructor(private readonly jwtService: JwtService) {}

  verifyTelegramInitData(initData: string, botToken: string): boolean {
    try {
      const parsed = new URLSearchParams(initData);
      const hash = parsed.get('hash');

      if (!hash) {
        return false;
      }

      // Remove 'hash' and sort keys
      parsed.delete('hash');
      const dataCheckString = [...parsed.entries()]
        .map(([key, val]) => `${key}=${val}`)
        .sort()
        .join('\n');

      // Compute HMAC
      const secretKey = crypto.createHash('sha256').update(botToken).digest();
      const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      return computedHash === hash;
    } catch {
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

  generateJwt(payload: JwtPayload): string {
    return this.jwtService.sign(payload);
  }

  verifyJwt(token: string): JwtPayload {
    return this.jwtService.verify(token);
  }
}
