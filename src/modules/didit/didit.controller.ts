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
import { RedisService } from '../redis/redis.service';
import { WebhookDto } from './dto/webhook.dto';
import * as crypto from 'crypto';

const MAX_WEBHOOK_AGE_SECONDS = 300;
// The body's own (signed) timestamp may be older than the header's on a
// retry, so it gets a wider window; replays inside it are stopped by
// event_id instead.
const MAX_EVENT_AGE_SECONDS = 24 * 60 * 60;
const EVENT_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

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
    private readonly redisService: RedisService,
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

    // X-Timestamp isn't signed (only the body is), so the signed body
    // timestamp and event_id are what stop a captured webhook being replayed.
    if (webhookData.timestamp !== undefined) {
      const age = Math.floor(Date.now() / 1000) - webhookData.timestamp;
      if (age > MAX_EVENT_AGE_SECONDS || age < -MAX_WEBHOOK_AGE_SECONDS) {
        this.logger.error(
          `Didit webhook rejected: event timestamp ${webhookData.timestamp} out of range`,
        );
        throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
      }
    }
    const eventKey = webhookData.event_id
      ? `dca:didit:event:${webhookData.event_id}`
      : null;
    if (
      eventKey &&
      !(await this.redisService.setIfAbsent(eventKey, EVENT_CLAIM_TTL_SECONDS))
    ) {
      this.logger.warn(
        `Ignoring repeated Didit event ${webhookData.event_id} for session ${webhookData.session_id}`,
      );
      return { success: true };
    }

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

      await this.userService.applyDiditResult(
        user.id,
        user.kyc_status,
        webhookData,
      );
      return { success: true };
    } catch (error) {
      // Not applied: release the claim so Didit's retry is processed
      if (eventKey) await this.redisService.del(eventKey);
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
}
