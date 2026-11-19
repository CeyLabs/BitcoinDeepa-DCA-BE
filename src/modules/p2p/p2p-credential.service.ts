import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CREDENTIAL_READ_MAX_AGE_SECONDS,
  WebIdTokenStore,
} from '../auth/web-id-token.store';
import type { P2pCredential } from './p2p-bot.client';

/** How old a credential the bot accepts for a send (its spend_init_data_max_age) */
export const CREDENTIAL_SPEND_MAX_AGE_SECONDS = 600;
/** Margin so a credential that's just in time here isn't too old at the bot */
const AGE_MARGIN_SECONDS = 30;

export type P2pPurpose = 'read' | 'spend';
export type P2pPlatform = 'mini_app' | 'web';

/** A credential to forward, with what the client needs to know about it */
export interface ResolvedCredential {
  credential: P2pCredential;
  platform: P2pPlatform;
  /** When it was issued (initData auth_date / id_token iat), seconds */
  issuedAt: number;
}

const maxAge = (purpose: P2pPurpose): number =>
  (purpose === 'spend'
    ? CREDENTIAL_SPEND_MAX_AGE_SECONDS
    : CREDENTIAL_READ_MAX_AGE_SECONDS) - AGE_MARGIN_SECONDS;

/** Until when (seconds) this credential is fresh enough to send */
export const spendFreshUntil = (issuedAt: number): number =>
  issuedAt + maxAge('spend');

/** user.id and auth_date from raw Mini App initData (the bot verifies the signature) */
export function parseInitData(
  raw: string,
): { userId: string; authDate: number } | null {
  try {
    const params = new URLSearchParams(raw);
    const authDate = Number(params.get('auth_date'));
    const user = JSON.parse(params.get('user') ?? 'null') as {
      id?: number | string;
    } | null;
    if (!user?.id || !Number.isFinite(authDate) || authDate <= 0) return null;
    return { userId: String(user.id), authDate };
  } catch {
    return null;
  }
}

/**
 * The Telegram credential to forward for a P2P call:
 * - Mini App: the raw initData the app sends in X-Telegram-Init-Data. It must
 *   be for the signed-in user; it's forwarded unchanged.
 * - Web: the latest "Log In with Telegram" id_token kept server-side.
 * Too old for the purpose (send: 10 min, read: 1 h, minus a margin) → 403
 * credential_stale, before calling the bot, so the app can ask for a fresh one.
 */
@Injectable()
export class P2pCredentialService {
  constructor(private readonly webIdTokens: WebIdTokenStore) {}

  async resolve(
    userId: string,
    initDataHeader: string | undefined,
    purpose: P2pPurpose,
  ): Promise<ResolvedCredential> {
    let resolved: ResolvedCredential;
    if (initDataHeader) {
      const parsed = parseInitData(initDataHeader);
      if (!parsed) {
        throw new BadRequestException({
          code: 'invalid_credential',
          message: 'Close and reopen the Mini App, then try again.',
        });
      }
      if (parsed.userId !== userId) {
        throw new ForbiddenException({
          code: 'credential_mismatch',
          message:
            'This Telegram session belongs to another account. Reopen the Mini App.',
        });
      }
      resolved = {
        credential: { kind: 'initData', value: initDataHeader },
        platform: 'mini_app',
        issuedAt: parsed.authDate,
      };
    } else {
      if (!this.webIdTokens.isAvailable()) {
        throw new ServiceUnavailableException({
          code: 'p2p_unavailable',
          message: 'Sending from the web is not available right now.',
        });
      }
      const stored = await this.webIdTokens.get(userId);
      if (!stored) throw stale('web');
      resolved = {
        credential: { kind: 'idToken', value: stored.token },
        platform: 'web',
        issuedAt: stored.iat,
      };
    }

    const age = Math.floor(Date.now() / 1000) - resolved.issuedAt;
    if (age > maxAge(purpose)) throw stale(resolved.platform);
    return resolved;
  }
}

function stale(platform: P2pPlatform): HttpException {
  return new HttpException(
    {
      code: 'credential_stale',
      platform,
      message:
        platform === 'mini_app'
          ? 'Your Telegram session is too old to send. Close and reopen the Mini App.'
          : 'Log in with Telegram again to send.',
    },
    // 403, not 401: our session is fine (a 401 makes the app sign the user out)
    HttpStatus.FORBIDDEN,
  );
}
