import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RedisService } from '../redis.service';
import {
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
} from '../decorators/cache.decorator';

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    private readonly redisService: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const cacheKey = this.reflector.get<string>(
      CACHE_KEY_METADATA,
      context.getHandler(),
    );
    const ttl = this.reflector.get<number>(
      CACHE_TTL_METADATA,
      context.getHandler(),
    );
    const keyGenerator = this.reflector.get<(...args: any[]) => string>(
      'cache:keyGenerator',
      context.getHandler(),
    );

    if (!cacheKey && !keyGenerator) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const args = [request.params, request.query, request.body].filter(Boolean);

    let finalKey: string;
    if (keyGenerator) {
      finalKey = keyGenerator(...args);
    } else {
      finalKey = cacheKey!;
    }

    // Try to get from cache
    const cachedValue = await this.redisService.get(finalKey);
    if (cachedValue !== null) {
      return of(cachedValue);
    }

    // If not in cache, execute handler and cache result
    return next.handle().pipe(
      tap(async (data) => {
        if (data !== null && data !== undefined) {
          await this.redisService.set(finalKey, data, { ttl });
        }
      }),
    );
  }
}
