import { Injectable, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from './auth.service';
import { BaseAuthGuard } from './base-auth.guard';

interface RequestWithUser extends Request {
  user: JwtPayload;
}

@Injectable()
export class JwtAuthGuard extends BaseAuthGuard {
  constructor(jwtService: JwtService) {
    super(jwtService);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    this.validateRequest(request);
    return true;
  }
}
