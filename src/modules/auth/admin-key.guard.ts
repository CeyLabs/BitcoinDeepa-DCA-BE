import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Protects internal/ops endpoints. Requires `x-admin-key` to match
 * ADMIN_API_KEY. If ADMIN_API_KEY is not set, the endpoint is closed.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_API_KEY;
    const provided = context
      .switchToHttp()
      .getRequest<Request>()
      .header('x-admin-key');

    if (!expected || !provided) {
      throw new ForbiddenException();
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
