import { Injectable, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from './auth.service';
import { BaseAuthGuard } from './base-auth.guard';

interface RequestWithUser extends Request {
  user: JwtPayload;
}

@Injectable()
export class ConditionalAuthGuard extends BaseAuthGuard {
  constructor(jwtService: JwtService) {
    super(jwtService);
  }

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
}
