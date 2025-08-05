import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserService } from '../user/user.service';
import { JwtPayload } from './auth.service';

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
      if (kycStatus?.status === 'Declined') {
        message = `KYC verification declined: ${kycStatus.rejection_reason || 'Please retry verification'}`;
      } else if (kycStatus?.status === 'Expired') {
        message = 'KYC verification session has expired. Please verify again';
      } else if (kycStatus?.status === 'Kyc Expired') {
        message = 'Previous KYC verification has expired. Please verify again';
      } else if (kycStatus?.status === 'Abandoned') {
        message =
          'KYC verification was abandoned. Please complete the verification process';
      } else if (kycStatus?.status === 'Not Started') {
        message =
          'KYC verification not started. Please complete the verification process';
      } else if (kycStatus?.status === 'In Progress') {
        message =
          'KYC verification is in progress. Please complete the verification process';
      } else if (kycStatus?.status === 'In Review') {
        message =
          'KYC verification is under manual review. Please wait for completion';
      }

      throw new ForbiddenException(message);
    }

    return true;
  }
}
