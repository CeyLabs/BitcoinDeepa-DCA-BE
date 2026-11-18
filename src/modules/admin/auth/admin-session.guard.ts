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
import {
  ADMIN_AUTH,
  ADMIN_ROLE,
  adminAppOrigins,
} from './admin-auth.constants';

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

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Protects admin dashboard endpoints: needs a valid Better Auth session
 * cookie belonging to a user with role `admin`. Requests that change state
 * must also come from the dashboard's origin (CSRF: the cookie alone would
 * ride along on a form posted from another page).
 */
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(@Inject(ADMIN_AUTH) private readonly auth: AdminAuth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithAdmin>();
    if (
      !SAFE_METHODS.includes(req.method) &&
      !adminAppOrigins().includes(req.header('origin') ?? '')
    ) {
      throw new ForbiddenException('Unexpected origin');
    }
    const session = await this.auth.api.getSession({ headers: toHeaders(req) });

    if (!session) throw new UnauthorizedException();
    if (session.user.role !== ADMIN_ROLE || session.user.banned) {
      throw new ForbiddenException();
    }

    req.admin = session;
    return true;
  }
}
