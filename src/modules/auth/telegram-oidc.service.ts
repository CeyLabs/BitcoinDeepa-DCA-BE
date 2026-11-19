import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { KnexService } from '../knex/knex.service';
import { errorMessage } from '../../common/error-message';
import {
  AuthService,
  type OidcRejection,
  type TelegramOidcClaims,
} from './auth.service';
import { appOrigins } from './cookies';

const AUTHORIZE_URL = 'https://oauth.telegram.org/auth';
const TOKEN_URL = 'https://oauth.telegram.org/token';
/** `profile` is required: it carries the numeric `id` (our user id) */
const DEFAULT_SCOPE = 'openid profile';
export const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 10_000;

/** The web login's ?login_error= codes */
export type LoginErrorCode =
  | OidcRejection
  | 'not_configured'
  | 'cancelled'
  | 'bad_state'
  | 'attempt_expired'
  | 'exchange_failed'
  | 'rate_limited';

export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode) {
    super(code);
  }
}

export interface LoginStart {
  attemptId: string;
  url: string;
}

export interface LoginResult {
  claims: TelegramOidcClaims;
  /** The fresh id_token, only to forward to the bot's /init; never stored */
  idToken: string;
  returnTo: string;
  referralCode: string | null;
}

interface AttemptRow {
  id: string;
  state_hash: Buffer;
  code_verifier: string;
  return_to: string;
  referral_code: string | null;
  expires_at: Date;
}

const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

/**
 * Only a same-app path: one leading "/", no "//" or "/\" (another host), no
 * control characters. Anything else returns to "/".
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || hasControlChar(value)) return '/';
  return value;
}

const hasControlChar = (value: string): boolean =>
  [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

export function safeReferralCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : null;
}

/**
 * Log In with Telegram, OIDC authorization code flow with PKCE (redirect
 * only). start saves a single-use attempt (state hash + code verifier) and
 * sends the browser to Telegram; the callback deletes that attempt before
 * anything else, then checks it, exchanges the code server-side (Basic
 * client_id:client_secret + code_verifier) and verifies the id_token.
 * Telegram's tokens are never kept: the id_token is only forwarded once to
 * the bot's /init by the caller.
 */
@Injectable()
export class TelegramOidcService {
  private readonly logger = new Logger(TelegramOidcService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly authService: AuthService,
  ) {}

  private get clientId(): string | undefined {
    return process.env.TELEGRAM_OIDC_CLIENT_ID;
  }

  isConfigured(): boolean {
    return !!(
      this.clientId &&
      process.env.TELEGRAM_OIDC_CLIENT_SECRET &&
      this.redirectUri() &&
      appOrigins().length > 0
    );
  }

  /** This API's callback (register it in BotFather > Login Widget) */
  redirectUri(): string | undefined {
    if (process.env.TELEGRAM_OIDC_REDIRECT_URI) {
      return process.env.TELEGRAM_OIDC_REDIRECT_URI;
    }
    const base = process.env.BASE_URL?.replace(/\/$/, '');
    return base ? `${base}/auth/telegram/callback` : undefined;
  }

  async start(params: {
    returnTo: unknown;
    referralCode: unknown;
  }): Promise<LoginStart> {
    if (!this.isConfigured()) throw new LoginError('not_configured');
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const [row] = await this.knexService
      .knex('telegram_login_attempt')
      .insert({
        state_hash: sha256(state),
        code_verifier: codeVerifier,
        return_to: safeReturnTo(params.returnTo),
        referral_code: safeReferralCode(params.referralCode),
        expires_at: new Date(Date.now() + LOGIN_ATTEMPT_TTL_MS),
      })
      .returning<{ id: string }[]>('id');

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.clientId as string);
    url.searchParams.set('redirect_uri', this.redirectUri() as string);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      process.env.TELEGRAM_OIDC_SCOPE || DEFAULT_SCOPE,
    );
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { attemptId: row.id, url: url.toString() };
  }

  async callback(params: {
    attemptId: string | undefined;
    code: unknown;
    state: unknown;
    error: unknown;
  }): Promise<LoginResult> {
    if (!this.isConfigured()) throw new LoginError('not_configured');
    const attempt = await this.takeAttempt(params.attemptId);

    if (params.error) throw new LoginError('cancelled');
    if (!attempt || new Date(attempt.expires_at).getTime() <= Date.now()) {
      throw new LoginError('attempt_expired');
    }
    if (
      typeof params.state !== 'string' ||
      !timingSafeEqual(sha256(params.state), Buffer.from(attempt.state_hash))
    ) {
      throw new LoginError('bad_state');
    }
    if (typeof params.code !== 'string' || !params.code) {
      throw new LoginError('exchange_failed');
    }

    const idToken = await this.exchangeCode(params.code, attempt.code_verifier);
    let claims: TelegramOidcClaims;
    try {
      claims = await this.authService.verifyTelegramOidcIdToken(
        idToken,
        this.clientId as string,
      );
    } catch (error) {
      const code = (error as { response?: { code?: OidcRejection } }).response
        ?.code;
      throw new LoginError(code ?? 'invalid_id_token');
    }
    return {
      claims,
      idToken,
      returnTo: attempt.return_to,
      referralCode: attempt.referral_code,
    };
  }

  /** Delete-and-return: an attempt can be used at most once */
  private async takeAttempt(
    attemptId: string | undefined,
  ): Promise<AttemptRow | null> {
    if (
      !attemptId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        attemptId,
      )
    ) {
      return null;
    }
    const [row] = await this.knexService
      .knex('telegram_login_attempt')
      .where({ id: attemptId })
      .del()
      .returning<AttemptRow[]>('*');
    return row ?? null;
  }

  private async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<string> {
    const basic = Buffer.from(
      `${this.clientId}:${process.env.TELEGRAM_OIDC_CLIENT_SECRET}`,
    ).toString('base64');
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri() as string,
          client_id: this.clientId as string,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({}))) as {
        id_token?: unknown;
        error?: unknown;
      };
      if (!response.ok || typeof body.id_token !== 'string') {
        this.logger.warn(
          `Telegram token exchange failed: HTTP ${response.status} ${typeof body.error === 'string' ? body.error : ''}`,
        );
        throw new LoginError('exchange_failed');
      }
      return body.id_token;
    } catch (error) {
      if (error instanceof LoginError) throw error;
      this.logger.warn(
        `Telegram token exchange failed: ${errorMessage(error)}`,
      );
      throw new LoginError('exchange_failed');
    }
  }
}
