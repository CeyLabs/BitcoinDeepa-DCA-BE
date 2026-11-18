import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AdminAuth, AdminSession } from './admin-auth.config';
import { ADMIN_AUTH, ADMIN_ROLE } from './admin-auth.constants';

export interface RequestWithAdmin extends Request {
  admin: AdminSession;
}

function toHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/**
 * Protects admin dashboard endpoints: needs a valid Better Auth session
 * cookie belonging to a user with role `admin`.
 */
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(@Inject(ADMIN_AUTH) private readonly auth: AdminAuth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithAdmin>();
    const session = await this.auth.api.getSession({ headers: toHeaders(req) });

    if (!session) throw new UnauthorizedException();
    if (session.user.role !== ADMIN_ROLE || session.user.banned) {
      throw new ForbiddenException();
    }

    req.admin = session;
    return true;
  }
}
