import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * P2P sends (a user's own bot wallet, relayed to the bot) are on by default.
 * P2P_ENABLED=false is the off-switch; without the bot key
 * (BITCOINDEEPA_PRIVATE_KEY_PEM) there is nothing to sign with, so it's
 * off too (the app shows "not available").
 */
export const isP2pEnabled = (): boolean =>
  process.env.P2P_ENABLED !== 'false' &&
  !!process.env.BITCOINDEEPA_PRIVATE_KEY_PEM;

/** 503 for the /p2p endpoints while P2P is off */
@Injectable()
export class P2pEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!isP2pEnabled()) {
      throw new ServiceUnavailableException(
        'Sending sats is not available yet',
      );
    }
    return true;
  }
}
