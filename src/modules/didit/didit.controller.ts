import {
  Controller,
  Post,
  Body,
  Logger,
  HttpStatus,
  HttpException,
  Headers,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiditService } from './didit.service';
import { UserService } from '../user/user.service';
import { WebhookDto } from './dto/webhook.dto';
import * as crypto from 'crypto';

@Controller('didit')
export class DiditController {
  private readonly logger = new Logger(DiditController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly diditService: DiditService,
    private readonly userService: UserService,
    private readonly configService: ConfigService,
  ) {
    this.webhookSecret =
      this.configService.get<string>('DIDIT_WEBHOOK_SECRET') || '';
  }

  @Post('webhook')
  async handleWebhook(
    @Body() webhookData: WebhookDto,
    @Headers('x-didit-signature') signature: string,
  ): Promise<{ success: boolean }> {
    this.logger.log(
      `Received Didit webhook for session ${webhookData.session_id}`,
    );

    // Verify webhook signature if secret is configured
    if (this.webhookSecret && signature) {
      const expectedSignature = this.generateWebhookSignature(
        JSON.stringify(webhookData),
      );
      if (signature !== expectedSignature) {
        this.logger.error('Invalid webhook signature');
        throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
      }
    }

    try {
      // Find user by session ID
      const user = await this.userService.getUserByKycSessionId(
        webhookData.session_id,
      );
      if (!user) {
        this.logger.error(
          `No user found for session ${webhookData.session_id}`,
        );
        throw new HttpException('User not found', HttpStatus.NOT_FOUND);
      }

      this.logger.log(
        `Processing webhook for user ${user.id}, status: ${webhookData.status}`,
      );

      // Update user KYC status based on webhook data
      await this.processKycResult(user.id, webhookData);

      return { success: true };
    } catch (error) {
      this.logger.error(`Error processing Didit webhook:`, error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Internal server error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async processKycResult(
    userId: string,
    webhookData: WebhookDto,
  ): Promise<void> {
    let rejectionReason: string | null = null;
    let verifiedAt: Date | null = null;

    // Use Didit's status directly, but handle 'Approved' specially
    let kycStatus = webhookData.status;

    if (webhookData.status === 'Approved') {
      // Check if verification was actually successful
      const isSuccessful = this.isVerificationSuccessful(webhookData);
      if (isSuccessful) {
        verifiedAt = new Date();
        this.logger.log(`KYC verification successful for user ${userId}`);
      } else {
        // If approved but verification checks failed, mark as declined
        kycStatus = 'Declined';
        rejectionReason = this.getFailureReason(webhookData);
        this.logger.log(
          `KYC verification approved but failed checks for user ${userId}: ${rejectionReason}`,
        );
      }
    } else {
      // For other statuses - set appropriate rejection reason
      if (webhookData.status === 'Declined') {
        rejectionReason = webhookData.failure_reason || 'Verification declined';
      } else if (webhookData.status === 'Expired') {
        rejectionReason = 'Verification session expired';
      } else if (webhookData.status === 'Abandoned') {
        rejectionReason = 'Verification was abandoned by user';
      } else if (webhookData.status === 'Kyc Expired') {
        rejectionReason = 'Previous KYC verification has expired';
      } else if (webhookData.status === 'In Review') {
        rejectionReason = 'Verification is under manual review';
      }

      this.logger.log(
        `KYC verification ${webhookData.status} for user ${userId}: ${rejectionReason || 'No reason provided'}`,
      );
    }

    // Update user's KYC status
    await this.userService.updateKycStatus(userId, {
      kyc_status: kycStatus,
      kyc_verified_at: verifiedAt,
      kyc_rejection_reason: rejectionReason,
    });

    this.logger.log(`Updated KYC status for user ${userId} to ${kycStatus}`);
  }

  private isVerificationSuccessful(webhookData: WebhookDto): boolean {
    const results = webhookData.verification_results;
    if (!results) {
      return false;
    }

    // Check if all required verifications passed
    const idVerificationPassed = results.id_verification?.status === 'passed';
    const livenessPassed = results.liveness_detection?.status === 'passed';

    return idVerificationPassed && livenessPassed;
  }

  private getFailureReason(webhookData: WebhookDto): string {
    if (webhookData.failure_reason) {
      return webhookData.failure_reason;
    }

    const results = webhookData.verification_results;
    if (!results) {
      return 'Verification failed';
    }

    const failures: string[] = [];

    if (results.id_verification?.status === 'failed') {
      failures.push('ID verification failed');
    }

    if (results.liveness_detection?.status === 'failed') {
      failures.push('Liveness detection failed');
    }

    if (results.face_match?.status === 'failed') {
      failures.push('Face match failed');
    }

    if (results.aml_screening?.status === 'failed') {
      failures.push('AML screening failed');
    }

    return failures.length > 0 ? failures.join(', ') : 'Verification failed';
  }

  private generateWebhookSignature(payload: string): string {
    return crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex');
  }
}
