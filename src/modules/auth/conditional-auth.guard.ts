import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from './auth.service';

interface RequestWithUser extends Request {
  user: JwtPayload;
}

@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if authentication is enabled
    const enableAuth = process.env.ENABLE_AUTH !== 'false';

    if (!enableAuth) {
      // If auth is disabled, create a mock user for development
      const request = context.switchToHttp().getRequest<RequestWithUser>();
      request.user = {
        user_id: String(process.env.MOCK_TG_ID),
        username: 'dev-username',
      };
      return true;
    }

    // Proceed with normal JWT authentication
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      // Assigning the payload to the request object here
      // so that we can access it in our route handlers
      request.user = payload;
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
