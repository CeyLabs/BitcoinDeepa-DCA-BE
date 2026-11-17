import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserService } from '../user/user.service';
import { JwtPayload } from './auth.service';
import { KycStatus } from '../user/enums/kyc-status.enum';

@Injectable()
export class KycVerifiedGuard implements CanActivate {
  constructor(
    private userService: UserService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if KYC verification is required for this endpoint
    const requireKyc = this.reflector.get<boolean>(
      'requireKyc',
      context.getHandler(),
    );
    if (!requireKyc) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    const kycStatus = await this.userService.getKycStatus(user.id);
    if (kycStatus.status !== KycStatus.APPROVED) {
      const messages: Partial<Record<KycStatus, string>> = {
        [KycStatus.DECLINED]: `KYC verification declined: ${kycStatus.rejection_reason || 'Please retry verification'}`,
        [KycStatus.EXPIRED]:
          'KYC verification session has expired. Please verify again',
        [KycStatus.KYC_EXPIRED]:
          'Previous KYC verification has expired. Please verify again',
        [KycStatus.ABANDONED]:
          'KYC verification was abandoned. Please complete the verification process',
        [KycStatus.NOT_STARTED]:
          'KYC verification not started. Please complete the verification process',
        [KycStatus.IN_PROGRESS]:
          'KYC verification is in progress. Please complete the verification process',
        [KycStatus.IN_REVIEW]:
          'KYC verification is under manual review. Please wait for completion',
      };
      throw new ForbiddenException(
        messages[kycStatus.status as KycStatus] ?? 'KYC verification required',
      );
    }

    return true;
  }
}
