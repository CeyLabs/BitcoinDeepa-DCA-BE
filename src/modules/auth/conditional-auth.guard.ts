import {
  Injectable,
  ExecutionContext,
  CanActivate,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from './auth.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';

interface RequestWithUser extends Request {
  user: JwtPayload;
}

@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly dbLogger: DatabaseLoggerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // Only allow auth bypass in development environment
    const isProduction = process.env.NODE_ENV === 'production';
    const enableAuth = process.env.ENABLE_AUTH !== 'false';

    // Force authentication in production regardless of ENABLE_AUTH setting
    if (isProduction) {
      await this.validateRequest(request);
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
      await this.dbLogger.info(
        `Development mode: Authentication bypassed for mock user ${mockUserId}`,
      );
      return true;
    }

    await this.validateRequest(request);
    return true;
  }

  private async validateRequest(request: RequestWithUser): Promise<void> {
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      await this.dbLogger.warn(
        'Unauthorized access attempt: No Bearer token provided',
      );
      throw new UnauthorizedException();
    }
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      request.user = payload;
      await this.dbLogger.info(
        `Successful JWT validation for user: ${payload.id}`,
      );
    } catch (error) {
      await this.dbLogger.warn(
        `JWT verification failed in guard: ${error.message}`,
      );
      throw new UnauthorizedException();
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
