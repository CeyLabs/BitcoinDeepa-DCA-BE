import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { RequestWithUser } from './conditional-auth.guard';

/**
 * For routes that move the user's sats (P2P, paying a sale): only a real
 * session, never a legacy 7-day JWT. Wallet calls name the user to the bot
 * with X-BDB-User and no Telegram credential, so before sessions a legacy
 * JWT couldn't spend (it needed fresh Telegram proof); it mustn't start now,
 * and logout-all can't revoke it. 403 relogin_required: log in again.
 * Put it after ConditionalAuthGuard.
 */
@Injectable()
export class SessionRequiredGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (user?.sessionKind === 'legacy') {
      throw new ForbiddenException({
        code: 'relogin_required',
        message: 'Please log in again to use your wallet.',
      });
    }
    return true;
  }
}
