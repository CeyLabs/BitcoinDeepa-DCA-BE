import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { JwtPayload } from '../../auth/auth.service';
import { BankAccountService } from '../bank-account.service';
import { BankAccountStatus } from '../bank-account.constants';

/**
 * Only users with an admin-verified bank account may sell. Use after
 * ConditionalAuthGuard (and KycVerifiedGuard).
 */
@Injectable()
export class BankVerifiedGuard implements CanActivate {
  constructor(private readonly bankAccounts: BankAccountService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context
      .switchToHttp()
      .getRequest<{ user?: JwtPayload }>().user;
    if (!user) throw new ForbiddenException('User not authenticated');

    if (await this.bankAccounts.getVerifiedAccount(user.id)) return true;

    const accounts = await this.bankAccounts.listForUser(user.id);
    if (accounts.some((a) => a.status === BankAccountStatus.PENDING_REVIEW)) {
      throw new ForbiddenException(
        'Your bank account is still being reviewed. You can sell once it is verified.',
      );
    }
    throw new ForbiddenException(
      'Add a bank account and wait for it to be verified before selling.',
    );
  }
}
