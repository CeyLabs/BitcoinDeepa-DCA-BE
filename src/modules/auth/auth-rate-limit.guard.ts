import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RedisService } from '../redis/redis.service';

/** Requests per client IP per minute, per login route */
export const AUTH_RATE_LIMIT_PER_MINUTE = 20;

const BUCKET = 'auth-rate-limit:bucket';

/** Name the route's bucket: `@AuthRateLimit('miniapp')` */
export const AuthRateLimit = (bucket: string) => SetMetadata(BUCKET, bucket);

/**
 * Fixed-window limit on the login routes only (start, callback, miniapp),
 * keyed by req.ip - the real client once TRUST_PROXY matches the proxies in
 * front of us (Railway's edge). Never put this on
 * /auth/me or logout: the app calls those all the time. Shared across
 * instances through Redis; without Redis it lets everything through.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AuthRateLimitGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket =
      this.reflector.get<string>(BUCKET, context.getHandler()) ?? 'auth';
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip ?? 'unknown';
    const window = Math.floor(Date.now() / 60_000);
    const count = await this.redis.incrWithTtl(
      `dca:auth-rl:${bucket}:${ip}:${window}`,
      61,
    );
    if (count !== null && count > AUTH_RATE_LIMIT_PER_MINUTE) {
      this.logger.warn(`Rate limited ${bucket} for ${ip} (${count}/min)`);
      throw new HttpException(
        {
          code: 'rate_limited',
          message: 'Too many attempts. Try again in a minute.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
