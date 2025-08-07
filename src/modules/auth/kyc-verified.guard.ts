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

    // Check if user's KYC is verified
    const isVerified = await this.userService.isKycVerified(user.id);
    if (!isVerified) {
      const kycStatus = await this.userService.getKycStatus(user.id);

      let message = 'KYC verification required';
      if (kycStatus?.status === KycStatus.DECLINED) {
        message = `KYC verification declined: ${kycStatus.rejection_reason || 'Please retry verification'}`;
      } else if (kycStatus?.status === KycStatus.EXPIRED) {
        message = 'KYC verification session has expired. Please verify again';
      } else if (kycStatus?.status === KycStatus.KYC_EXPIRED) {
        message = 'Previous KYC verification has expired. Please verify again';
      } else if (kycStatus?.status === KycStatus.ABANDONED) {
        message =
          'KYC verification was abandoned. Please complete the verification process';
      } else if (kycStatus?.status === KycStatus.NOT_STARTED) {
        message =
          'KYC verification not started. Please complete the verification process';
      } else if (kycStatus?.status === KycStatus.IN_PROGRESS) {
        message =
          'KYC verification is in progress. Please complete the verification process';
      } else if (kycStatus?.status === KycStatus.IN_REVIEW) {
        message =
          'KYC verification is under manual review. Please wait for completion';
      }

      throw new ForbiddenException(message);
    }

    return true;
  }
}
