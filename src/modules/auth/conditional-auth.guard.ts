import {
  Injectable,
  ExecutionContext,
  CanActivate,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from './auth.service';
import { errorMessage } from '../../common/error-message';

interface RequestWithUser extends Request {
  user: JwtPayload;
}

@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  private readonly logger = new Logger(ConditionalAuthGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // Only allow auth bypass in development environment
    const isProduction = process.env.NODE_ENV === 'production';
    const enableAuth = process.env.ENABLE_AUTH !== 'false';

    // Force authentication in production regardless of ENABLE_AUTH setting
    if (isProduction) {
      this.validateRequest(request);
      return true;
    }

    // In non-production environments, check ENABLE_AUTH setting
    if (!enableAuth) {
      // If auth is disabled in development, create a mock user
      const mockUserId = process.env.MOCK_TG_ID || 'dev-user-123';
      request.user = {
        id: mockUserId,
        username: 'dev-username',
      };
      this.logger.log(
        `Development mode: Authentication bypassed for mock user ${mockUserId}`,
      );
      return true;
    }

    this.validateRequest(request);
    return true;
  }

  private validateRequest(request: RequestWithUser): void {
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      this.logger.warn('Unauthorized access attempt: No Bearer token provided');
      throw new UnauthorizedException();
    }
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      request.user = payload;
      // debug = console only; logging every request to the DB is noise
      this.logger.debug(`Successful JWT validation for user: ${payload.id}`);
    } catch (error) {
      this.logger.warn(
        `JWT verification failed in guard: ${errorMessage(error)}`,
      );
      throw new UnauthorizedException();
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
