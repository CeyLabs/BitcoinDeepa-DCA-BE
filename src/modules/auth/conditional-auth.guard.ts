import {
  Injectable,
  ExecutionContext,
  CanActivate,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from './auth.service';
import { looksLikeSessionToken, SessionService } from './session.service';
import { appOrigins, readCookie, sessionCookieName } from './cookies';
import { errorMessage } from '../../common/error-message';

export interface RequestWithUser extends Request {
  user: JwtPayload & { sessionId?: string; sessionKind?: string };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Who is calling, from exactly one credential:
 * 1. `Authorization: Bearer <token>` (the Mini App's session, or a legacy
 *    7-day JWT until they expire). When present it decides alone: a bad
 *    Bearer never falls back to the cookie.
 * 2. Otherwise the session cookie (web). Cookies are sent by the browser on
 *    its own, so writes also need an Origin from APP_URL (CSRF).
 * ENABLE_AUTH=false (never in production) gives a mock user.
 */
@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  private readonly logger = new Logger(ConditionalAuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const isProduction = process.env.NODE_ENV === 'production';
    const enableAuth = process.env.ENABLE_AUTH !== 'false';

    if (!isProduction && !enableAuth) {
      const mockUserId = process.env.MOCK_TG_ID || 'dev-user-123';
      request.user = { id: mockUserId, username: 'dev-username' };
      this.logger.log(
        `Development mode: Authentication bypassed for mock user ${mockUserId}`,
      );
      return true;
    }

    request.user = await this.authenticate(request);
    return true;
  }

  private async authenticate(
    request: RequestWithUser,
  ): Promise<RequestWithUser['user']> {
    const bearer = this.extractBearer(request);
    if (bearer !== undefined) {
      const user = await this.fromBearer(bearer);
      if (!user) throw new UnauthorizedException();
      return user;
    }

    const cookie = readCookie(request, sessionCookieName());
    if (cookie) {
      const user = await this.sessions.validate(cookie);
      if (!user) throw new UnauthorizedException();
      this.checkOrigin(request);
      return user;
    }

    this.logger.debug('Unauthorized: no Bearer token or session cookie');
    throw new UnauthorizedException();
  }

  private async fromBearer(
    token: string,
  ): Promise<RequestWithUser['user'] | null> {
    if (looksLikeSessionToken(token)) return this.sessions.validate(token);
    // Legacy 7-day JWT (issued before sessions); removed once they expired
    try {
      const { id, username } = this.jwtService.verify<JwtPayload>(token);
      return { id, username };
    } catch (error) {
      this.logger.debug(`Legacy JWT rejected: ${errorMessage(error)}`);
      return null;
    }
  }

  /** CSRF: a cookie-authenticated write must come from the app's origin */
  private checkOrigin(request: Request): void {
    if (SAFE_METHODS.has(request.method)) return;
    const allowed = appOrigins();
    // Unset APP_URL is only allowed outside production (env validation)
    if (allowed.length === 0) return;
    const origin = request.header('origin');
    if (!origin || !allowed.includes(origin)) {
      this.logger.warn(
        `Blocked cookie-authenticated ${request.method} ${request.path} from origin ${origin ?? '(none)'}`,
      );
      throw new ForbiddenException('Invalid origin');
    }
  }

  private extractBearer(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [type, token] = header.split(' ');
    // A malformed Authorization header still counts as "a Bearer was sent"
    return type === 'Bearer' && token ? token : '';
  }
}
