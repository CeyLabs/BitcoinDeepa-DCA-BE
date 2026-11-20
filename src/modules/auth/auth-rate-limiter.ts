import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * Per-minute limits on the login routes only - never /auth/me or logout,
 * which the app calls all the time.
 * - start/callback: per client IP (req.ip, real once TRUST_PROXY matches the
 *   proxies in front of us)
 * - miniapp: runs on every Mini App launch and mobile carriers put many users
 *   behind one IP (CGNAT), so the IP limit is loose and the real limit is
 *   per Telegram user, counted after initData is verified
 */
export const AUTH_RATE_LIMITS = {
  start: 20,
  callback: 20,
  miniapp: 120,
  miniappUser: 10,
} as const;

export type AuthRateLimitBucket = keyof typeof AUTH_RATE_LIMITS;

export class AuthRateLimitedError extends HttpException {
  constructor() {
    super(
      {
        code: 'rate_limited',
        message: 'Too many attempts. Try again in a minute.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Fixed one-minute windows in Redis (shared by all instances; open without Redis) */
@Injectable()
export class AuthRateLimiter {
  private readonly logger = new Logger(AuthRateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  /** Count one hit for `subject` (an IP or a Telegram id); throws when over */
  async hit(bucket: AuthRateLimitBucket, subject: string): Promise<void> {
    const window = Math.floor(Date.now() / 60_000);
    const count = await this.redis.incrWithTtl(
      `dca:auth-rl:${bucket}:${subject}:${window}`,
      61,
    );
    if (count !== null && count > AUTH_RATE_LIMITS[bucket]) {
      this.logger.warn(`Rate limited ${bucket} for ${subject} (${count}/min)`);
      throw new AuthRateLimitedError();
    }
  }
}
