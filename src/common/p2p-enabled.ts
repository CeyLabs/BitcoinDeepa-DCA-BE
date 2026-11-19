import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

/** P2P sends (a user's own bot wallet, relayed to the bot) are off unless P2P_ENABLED=true */
export const isP2pEnabled = (): boolean => process.env.P2P_ENABLED === 'true';

/** 503 for the /p2p endpoints while P2P is switched off */
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
