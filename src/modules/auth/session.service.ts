import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { KnexService } from '../knex/knex.service';
import type { JwtPayload } from './auth.service';

export type SessionKind = 'web' | 'miniapp';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Per kind: idle timeout (slides while the user is active), hard limit from
 * creation, and how often activity is written (at most once per touchEvery,
 * so a busy user doesn't update their row on every request).
 * Both stay well under the bot's 1-year X-BDB-User link, which every login
 * renews.
 */
export const SESSION_POLICY: Record<
  SessionKind,
  { idleMs: number; absoluteMs: number; touchEveryMs: number }
> = {
  web: { idleMs: 30 * DAY, absoluteMs: 180 * DAY, touchEveryMs: DAY },
  miniapp: { idleMs: DAY, absoluteMs: 7 * DAY, touchEveryMs: HOUR },
};

export interface SessionUser extends JwtPayload {
  sessionId: string;
  sessionKind: SessionKind;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  kind: SessionKind;
  last_seen_at: Date;
  absolute_expires_at: Date;
  username: string | null;
}

export const hashToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

/** 32 random bytes, base64url: 43 chars, never contains '.' (legacy JWTs do) */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const looksLikeSessionToken = (token: string): boolean =>
  TOKEN_PATTERN.test(token);

/**
 * Server-side sessions for the user app. The token is 32 random bytes handed
 * to the client once (cookie on the web, response body in the Mini App); only
 * its SHA-256 is stored, so a DB leak doesn't leak usable tokens.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly knexService: KnexService) {}

  private get knex() {
    return this.knexService.knex;
  }

  async create(
    userId: string,
    kind: SessionKind,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<CreatedSession> {
    const policy = SESSION_POLICY[kind];
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + policy.absoluteMs);
    const idleExpiresAt = new Date(
      Math.min(now + policy.idleMs, absoluteExpiresAt.getTime()),
    );
    const [row] = await this.knex('user_session')
      .insert({
        user_id: userId,
        token_hash: hashToken(token),
        kind,
        idle_expires_at: idleExpiresAt,
        absolute_expires_at: absoluteExpiresAt,
        user_agent: meta.userAgent?.slice(0, 512) ?? null,
        ip: meta.ip?.slice(0, 64) ?? null,
      })
      .returning<{ id: string }[]>('id');
    return { token, sessionId: row.id, idleExpiresAt, absoluteExpiresAt };
  }

  /**
   * The session's user, or null when the token is unknown, revoked or
   * expired. Slides the idle timeout (capped at the hard limit) at most once
   * per touchEvery.
   */
  async validate(token: string): Promise<SessionUser | null> {
    if (!looksLikeSessionToken(token)) return null;
    const now = new Date();
    const row = await this.knex('user_session as s')
      .join('user as u', 'u.id', 's.user_id')
      .where('s.token_hash', hashToken(token))
      .whereNull('s.revoked_at')
      .where('s.idle_expires_at', '>', now)
      .where('s.absolute_expires_at', '>', now)
      .first<
        SessionRow | undefined
      >('s.id', 's.user_id', 's.kind', 's.last_seen_at', 's.absolute_expires_at', 'u.username');
    if (!row) return null;

    const policy = SESSION_POLICY[row.kind];
    if (
      now.getTime() - new Date(row.last_seen_at).getTime() >=
      policy.touchEveryMs
    ) {
      const idle = new Date(
        Math.min(
          now.getTime() + policy.idleMs,
          new Date(row.absolute_expires_at).getTime(),
        ),
      );
      // Conditional on last_seen_at, so concurrent requests write once
      await this.knex('user_session')
        .where({ id: row.id, last_seen_at: row.last_seen_at })
        .update({ last_seen_at: now, idle_expires_at: idle })
        .catch((error: unknown) =>
          this.logger.warn(`Session touch failed: ${String(error)}`),
        );
    }

    return {
      id: row.user_id,
      username: row.username ?? undefined,
      sessionId: row.id,
      sessionKind: row.kind,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.knex('user_session')
      .where({ id: sessionId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
  }

  /** Every session of the user (all devices); returns how many */
  async revokeAllForUser(userId: string): Promise<number> {
    return this.knex('user_session')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
  }

  /**
   * Housekeeping: expired sessions, sessions revoked more than a week ago
   * and expired login attempts.
   */
  async deleteExpired(): Promise<{ sessions: number; attempts: number }> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const sessions = await this.knex('user_session')
      .where('idle_expires_at', '<', now)
      .orWhere('absolute_expires_at', '<', now)
      .orWhere('revoked_at', '<', weekAgo)
      .del();
    const attempts = await this.knex('telegram_login_attempt')
      .where('expires_at', '<', now)
      .del();
    return { sessions, attempts };
  }
}
