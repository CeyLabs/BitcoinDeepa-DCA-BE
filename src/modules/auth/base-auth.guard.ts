import {
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

export abstract class BaseAuthGuard implements CanActivate {
  constructor(protected jwtService: JwtService) {}

  protected validateRequest(request: RequestWithUser): void {
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

  protected extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  abstract canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}
