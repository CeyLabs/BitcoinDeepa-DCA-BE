import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AdminSession } from './admin-auth.config';
import type { RequestWithAdmin } from './admin-session.guard';

/** The admin session attached by AdminSessionGuard. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminSession =>
    ctx.switchToHttp().getRequest<RequestWithAdmin>().admin,
);
