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

/**
 * The Mini App exchanges initData for a session once, at launch, so a short
 * window limits how long a leaked initData can be replayed. Kept under the
 * bot's 1 h init_data_max_age: the same initData goes on to its /init.
 */
export const MINIAPP_INITDATA_MAX_AGE_SECONDS = 15 * 60;

/** Why a Telegram OIDC id_token was refused (the web login's ?error= code) */
export type OidcRejection = 'missing_telegram_id' | 'invalid_id_token';

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

  /**
   * Mini App initData: HMAC-SHA256 keyed with HMAC("WebAppData", botToken)
   * over the sorted key=value lines (all but hash), constant-time compare,
   * and auth_date at most maxAgeSeconds old. Separate from the OIDC check.
   */
  verifyTelegramMiniAppInitData(
    initData: string,
    botToken: string,
    maxAgeSeconds = MINIAPP_INITDATA_MAX_AGE_SECONDS,
  ): boolean {
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
   * BotFather). jwtVerify also rejects expired tokens. The numeric `id`
   * claim (scope `profile`) is the Telegram user ID and our user id; `sub` is
   * not, and is never used in its place: a token without `id` is refused
   * (missing_telegram_id) rather than creating a second account.
   * https://core.telegram.org/bots/telegram-login#validating-id-tokens
   */
  async verifyTelegramOidcIdToken(
    idToken: string,
    clientId: string,
  ): Promise<TelegramOidcClaims> {
    let payload: JWTPayload;
    try {
      const { jwtVerify } = await importJose();
      const jwks = await getTelegramJwks();
      ({ payload } = await jwtVerify(idToken, jwks, {
        issuer: TELEGRAM_OIDC_ISSUER,
        audience: clientId,
        // Telegram's default; update if BotFather's Login Widget > Advanced
        // signing algorithm is changed.
        algorithms: ['RS256'],
      }));
    } catch (error) {
      this.logger.warn(
        `Telegram OIDC id_token verification failed: ${errorMessage(error)}`,
      );
      throw oidcRejected('invalid_id_token');
    }

    const rawId = payload.id;
    const isNumericId =
      (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) ||
      (typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId));
    if (!isNumericId) {
      this.logger.warn('Telegram OIDC id_token has no numeric "id" claim');
      throw oidcRejected('missing_telegram_id');
    }
    return { ...payload, id: String(rawId) } as TelegramOidcClaims;
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

function oidcRejected(code: OidcRejection): UnauthorizedException {
  return new UnauthorizedException({
    code,
    message: 'Invalid Telegram login token',
  });
}
