import {
  Injectable,
  ExecutionContext,
  CanActivate,
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
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if authentication is enabled
    const enableAuth = process.env.ENABLE_AUTH !== 'false';

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    if (!enableAuth) {
      // If auth is disabled, create a mock user for development
      request.user = {
        user_id: String(process.env.MOCK_TG_ID),
        username: 'dev-username',
      };
      return true;
    }

    this.validateRequest(request);
    return true;
  }

  private validateRequest(request: RequestWithUser): void {
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      request.user = payload;
    } catch {
      throw new UnauthorizedException();
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
