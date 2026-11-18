import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { errorMessage } from '../../common/error-message';

export interface CacheOptions {
  /** TTL in seconds */
  ttl?: number;
}

/**
 * JSON cache backed by Redis (ioredis). Cache calls never throw: if Redis is
 * not configured or unreachable they behave as cache misses.
 *
 * There is deliberately no in-memory fallback: a per-process cache silently
 * diverges between instances, and local dev already gets Redis from
 * docker-compose. No Redis = no caching, which is always correct.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly defaultTtlSeconds = parseInt(
    process.env.REDIS_TTL_DEFAULT || '300',
    10,
  );
  private redis: Redis | null = null;

  async onModuleInit(): Promise<void> {
    const options = this.buildOptions();
    if (!options) {
      this.logger.warn('REDIS_URL / REDIS_HOST not set - caching disabled');
      return;
    }

    this.redis = new Redis(options);
    this.redis.on('error', (error) =>
      this.logger.error(`Redis error: ${errorMessage(error)}`),
    );
    this.redis.on('reconnecting', () => this.logger.warn('Redis reconnecting'));

    try {
      await this.redis.connect();
      this.logger.log('Redis connected');
    } catch (error) {
      // ioredis keeps retrying in the background; cache calls are misses until then
      this.logger.error(
        `Initial Redis connection failed: ${errorMessage(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => this.redis?.disconnect());
    }
  }

  private buildOptions(): RedisOptions | null {
    const base: RedisOptions = {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 30000,
      commandTimeout: 10000,
      lazyConnect: true,
      enableOfflineQueue: false,
      keepAlive: 30000,
    };

    if (process.env.REDIS_URL) {
      const url = new URL(process.env.REDIS_URL);
      return {
        ...base,
        host: url.hostname,
        port: parseInt(url.port, 10) || 6379,
        db: parseInt(url.pathname.slice(1), 10) || 0,
        username: url.username || undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        tls: url.protocol === 'rediss:' ? {} : undefined,
      };
    }

    if (process.env.REDIS_HOST) {
      return {
        ...base,
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        db: parseInt(process.env.REDIS_DATABASE || '0', 10),
        username: process.env.REDIS_USERNAME || undefined,
        password: process.env.REDIS_PASSWORD || undefined,
      };
    }

    return null;
  }

  async ping(): Promise<boolean> {
    if (!this.redis) return true; // caching disabled is not a failure
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.logger.warn(`Cache GET failed for ${key}: ${String(error)}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    if (!this.redis) return;
    const ttl = options?.ttl ?? this.defaultTtlSeconds;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      this.logger.warn(`Cache SET failed for ${key}: ${String(error)}`);
    }
  }

  /**
   * Atomically claim `key` for `ttlSeconds` (SET NX). true = claimed now,
   * false = already claimed. With Redis unavailable it answers true, so a
   * cache outage never blocks the caller (claims are a best-effort dedupe).
   */
  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.redis) return true;
    try {
      return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch (error) {
      this.logger.warn(`Cache SET NX failed for ${key}: ${String(error)}`);
      return true;
    }
  }

  /**
   * Return the cached value, or run `loader`, cache its result and return it.
   * null/undefined results are not cached.
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T | null | undefined>,
  ): Promise<T | null> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const value = await loader();
    if (value === null || value === undefined) {
      return null;
    }
    await this.set(key, value, { ttl: ttlSeconds });
    return value;
  }

  async del(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(key);
    } catch (error) {
      this.logger.warn(`Cache DEL failed for ${key}: ${String(error)}`);
    }
  }

  /** Delete keys matching a glob pattern (uses SCAN, not KEYS). */
  async delByPattern(pattern: string): Promise<number> {
    if (!this.redis) return 0;
    try {
      let deleted = 0;
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          200,
        );
        cursor = next;
        if (keys.length > 0) {
          deleted += await this.redis.del(...keys);
        }
      } while (cursor !== '0');
      return deleted;
    } catch (error) {
      this.logger.warn(
        `Cache DEL pattern failed for ${pattern}: ${String(error)}`,
      );
      return 0;
    }
  }
}
