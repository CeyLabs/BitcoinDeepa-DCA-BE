import {
  Controller,
  Post,
  Body,
  Logger,
  HttpStatus,
  HttpException,
  Headers,
  Req,
  RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UserService } from '../user/user.service';
import { WebhookDto } from './dto/webhook.dto';
import { DiditStatusMapping, KycStatus } from '../user/enums/kyc-status.enum';
import * as crypto from 'crypto';

const MAX_WEBHOOK_AGE_SECONDS = 300;

const REJECTION_REASONS: Record<string, string> = {
  Expired: 'Verification session expired',
  Abandoned: 'Verification was abandoned by user',
  'Kyc Expired': 'Previous KYC verification has expired',
  'In Review': 'Verification is under manual review',
  Resubmitted: 'Reviewer asked to redo some verification steps',
};

// Once a session has one of these results, a late "Not Started"/"In Progress"
// webhook for the same session must not overwrite it.
const FINAL_KYC_STATUSES: string[] = [
  KycStatus.APPROVED,
  KycStatus.DECLINED,
  KycStatus.IN_REVIEW,
  KycStatus.EXPIRED,
  KycStatus.ABANDONED,
  KycStatus.KYC_EXPIRED,
];

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

@Controller('didit')
export class DiditController {
  private readonly logger = new Logger(DiditController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly userService: UserService,
    private readonly configService: ConfigService,
  ) {
    this.webhookSecret =
      this.configService.get<string>('DIDIT_WEBHOOK_SECRET') || '';
  }

  @Post('webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() webhookData: WebhookDto,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-timestamp') timestamp: string | undefined,
  ): Promise<{ success: boolean }> {
    this.verifySignature(req.rawBody, { signature, timestamp });

    this.logger.log(
      `Received Didit webhook for session ${webhookData.session_id} (status: ${webhookData.status})`,
    );

    try {
      const user = await this.userService.getUserByKycSessionId(
        webhookData.session_id,
      );
      if (!user) {
        this.logger.error(
          `No user found for session ${webhookData.session_id}`,
        );
        throw new HttpException('User not found', HttpStatus.NOT_FOUND);
      }

      await this.processKycResult(user.id, user.kyc_status, webhookData);
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

  /**
   * Didit signs every webhook with HMAC-SHA256 (https://docs.didit.me/integration/webhooks):
   *  - X-Signature: over the exact raw body bytes
   *  - X-Timestamp: unix seconds; reject if more than 5 minutes off
   *
   * Didit also sends X-Signature-V2 (HMAC of re-serialized, key-sorted JSON)
   * for frameworks that can't read the raw body. We don't need it: main.ts
   * enables `rawBody`, so X-Signature is exact and simpler to verify.
   *
   * The secret is mandatory in production (enforced by env validation too).
   */
  private verifySignature(
    rawBody: Buffer | undefined,
    headers: {
      signature?: string;
      timestamp?: string;
    },
  ): void {
    if (!this.webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          'DIDIT_WEBHOOK_SECRET is not set - rejecting Didit webhook',
        );
        throw new HttpException(
          'Webhook verification not configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      this.logger.warn(
        'DIDIT_WEBHOOK_SECRET not set - accepting unsigned webhook (non-production only)',
      );
      return;
    }

    const unauthorized = (reason: string) => {
      this.logger.error(`Didit webhook rejected: ${reason}`);
      return new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    };

    if (!rawBody || !headers.timestamp) {
      throw unauthorized('missing body or X-Timestamp');
    }

    const ts = parseInt(headers.timestamp, 10);
    if (
      !Number.isFinite(ts) ||
      Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_WEBHOOK_AGE_SECONDS
    ) {
      throw unauthorized('stale or invalid X-Timestamp');
    }

    const hmac = (payload: string | Buffer) =>
      crypto
        .createHmac('sha256', this.webhookSecret)
        .update(payload)
        .digest('hex');

    if (!headers.signature || !safeEqualHex(headers.signature, hmac(rawBody))) {
      throw unauthorized('signature mismatch');
    }
  }

  private async processKycResult(
    userId: string,
    currentStatus: string | undefined,
    webhookData: WebhookDto,
  ): Promise<void> {
    const dbStatus = DiditStatusMapping[webhookData.status];
    if (!dbStatus) {
      // e.g. "Awaiting User" (KYB only) - nothing to do for a KYC user
      this.logger.warn(`Ignoring Didit status: ${webhookData.status}`);
      return;
    }

    const isProgressUpdate =
      webhookData.status === 'Not Started' ||
      webhookData.status === 'In Progress';
    if (
      isProgressUpdate &&
      currentStatus &&
      FINAL_KYC_STATUSES.includes(currentStatus)
    ) {
      this.logger.warn(
        `Ignoring late "${webhookData.status}" webhook for user ${userId} (already ${currentStatus})`,
      );
      return;
    }

    const approved = webhookData.status === 'Approved';
    const rejectionReason = approved
      ? null
      : webhookData.status === 'Declined'
        ? webhookData.failure_reason || 'Verification declined'
        : (REJECTION_REASONS[webhookData.status] ?? null);

    await this.userService.updateKycStatus(userId, {
      kyc_status: dbStatus,
      kyc_verified_at: approved ? new Date() : null,
      kyc_rejection_reason: rejectionReason,
    });

    this.logger.log(
      `Updated KYC status for user ${userId} to ${dbStatus} (Didit: ${webhookData.status}${rejectionReason ? `, reason: ${rejectionReason}` : ''})`,
    );
  }
}
