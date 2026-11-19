import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

/** Selling (and the bank accounts it pays out to) is off unless SELL_ENABLED=true */
export const isSellEnabled = (): boolean => process.env.SELL_ENABLED === 'true';

/** 503 for the sell and bank-account endpoints while selling is switched off */
@Injectable()
export class SellEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!isSellEnabled()) {
      throw new ServiceUnavailableException('Selling is not available yet');
    }
    return true;
  }
}
