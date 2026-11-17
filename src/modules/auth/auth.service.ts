import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as dayjs from 'dayjs';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { errorMessage } from '../../common/error-message';

const TELEGRAM_OIDC_ISSUER = 'https://oauth.telegram.org';
const TELEGRAM_OIDC_JWKS_URL =
  'https://oauth.telegram.org/.well-known/jwks.json';

// jose is ESM-only. tsc compiles this project to CommonJS and rewrites
// `await import(...)` into `Promise.resolve().then(() => require(...))` —
// still a require() under the hood, which throws ERR_REQUIRE_ESM on Node 18
// (unlike Node 22+, it has no require(esm) support at all). Routing the
// import through `new Function` hides it from tsc's rewrite so Node executes
// a real dynamic import() instead.
// Not eval of user input; this is the standard escape hatch to stop tsc
// rewriting import() into require().
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importJose = new Function('return import("jose")') as () => Promise<
  typeof import('jose')
>;

let telegramJwksPromise: Promise<JWTVerifyGetKey> | null = null;
async function getTelegramJwks(): Promise<JWTVerifyGetKey> {
  if (!telegramJwksPromise) {
    telegramJwksPromise = importJose().then(({ createRemoteJWKSet }) =>
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

// Claims Telegram puts in the id_token — see
// https://core.telegram.org/bots/telegram-login#user-data-structure
// Telegram's docs say `id` is a number, but in practice it's sent as a
// numeric string (verified against a real id_token payload).
export interface TelegramOidcClaims extends JWTPayload {
  id: string;
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
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly jwtService: JwtService) {}

  verifyTelegramInitData(initData: string, botToken: string): boolean {
    try {
      const parsed = new URLSearchParams(initData);
      const hash = parsed.get('hash');
      const authDate = parsed.get('auth_date');

      if (!hash || !authDate) {
        this.logger.warn(
          'Missing hash or auth_date in Telegram init data verification',
        );
        return false;
      }

      // Validate timestamp to prevent replay attacks
      const authTimestamp = parseInt(authDate, 10);
      if (isNaN(authTimestamp)) {
        this.logger.warn('Invalid timestamp format in Telegram init data');
        return false;
      }

      const ageSeconds = dayjs().diff(dayjs.unix(authTimestamp), 'second');
      // initData is exchanged for a 7-day JWT right at app launch, so a
      // short window limits how long a leaked initData can be replayed.
      const maxAgeSeconds = 60 * 60; // 1 hour
      const maxClockSkewSeconds = 60;

      if (ageSeconds > maxAgeSeconds || ageSeconds < -maxClockSkewSeconds) {
        this.logger.warn(
          `Rejected Telegram auth data - age: ${ageSeconds}s (allowed: -${maxClockSkewSeconds}s to ${maxAgeSeconds}s)`,
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

      const computed = Buffer.from(computedHash, 'hex');
      const received = Buffer.from(hash, 'hex');
      const isValid =
        received.length === computed.length &&
        crypto.timingSafeEqual(computed, received);
      if (!isValid) {
        this.logger.warn('Hash verification failed for Telegram init data');
      }

      return isValid;
    } catch (error) {
      this.logger.error(
        `Exception during Telegram init data verification: ${errorMessage(error)}`,
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
      const { jwtVerify } = await importJose();
      const jwks = await getTelegramJwks();
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: TELEGRAM_OIDC_ISSUER,
        audience: clientId,
        // Telegram's default; update if BotFather's Login Widget > Advanced
        // signing algorithm is changed.
        algorithms: ['RS256'],
      });

      const rawId = payload.id;
      const isNumericId =
        typeof rawId === 'number' ||
        (typeof rawId === 'string' && /^\d+$/.test(rawId));
      if (!isNumericId) {
        throw new Error('id_token missing numeric "id" claim');
      }

      return { ...payload, id: String(rawId) } as TelegramOidcClaims;
    } catch (error) {
      this.logger.warn(
        `Telegram OIDC id_token verification failed: ${errorMessage(error)}`,
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

  generateJwt(payload: JwtPayload): string {
    const token = this.jwtService.sign(payload);
    this.logger.log(`JWT token generated for user: ${payload.id}`);
    return token;
  }
}
