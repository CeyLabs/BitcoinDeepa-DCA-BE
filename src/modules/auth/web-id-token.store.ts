import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';

/** How long the bot accepts a Telegram credential for reads (its init_data_max_age) */
export const CREDENTIAL_READ_MAX_AGE_SECONDS = 3600;

export interface StoredIdToken {
  token: string;
  /** The token's `iat`, in seconds */
  iat: number;
}

/**
 * The web app's latest verified "Log In with Telegram" id_token, kept
 * server-side (the bot's guide: never in browser storage) so P2P calls can
 * forward it. Saved at login, replaced by every login, gone once the bot
 * would stop accepting it (iat + 1 h). Needs Redis: without it nothing is kept.
 */
@Injectable()
export class WebIdTokenStore {
  constructor(private readonly redis: RedisService) {}

  isAvailable(): boolean {
    return this.redis.isEnabled();
  }

  async save(userId: string, token: string, iat: number): Promise<void> {
    const ttl =
      iat + CREDENTIAL_READ_MAX_AGE_SECONDS - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return;
    await this.redis.set<StoredIdToken>(
      CacheKeys.p2p.webIdToken(userId),
      { token, iat },
      { ttl },
    );
  }

  get(userId: string): Promise<StoredIdToken | null> {
    return this.redis.get<StoredIdToken>(CacheKeys.p2p.webIdToken(userId));
  }
}
