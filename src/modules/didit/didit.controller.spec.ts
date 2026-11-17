import { HttpException, RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac } from 'crypto';
import { DiditController } from './didit.controller';
import { UserService } from '../user/user.service';
import { KycStatus } from '../user/enums/kyc-status.enum';
import { WebhookDto } from './dto/webhook.dto';

const SECRET = 'didit-secret';
const now = () => String(Math.floor(Date.now() / 1000));

function setup(secret = SECRET, currentStatus: string = KycStatus.IN_PROGRESS) {
  // Real UserService (it owns the status logic), database calls stubbed
  const realUserService = new UserService({} as never);
  const userService = {
    getUserByKycSessionId: jest
      .spyOn(realUserService, 'getUserByKycSessionId')
      .mockResolvedValue({ id: 'u1', kyc_status: currentStatus } as never),
    updateKycStatus: jest
      .spyOn(realUserService, 'updateKycStatus')
      .mockResolvedValue(undefined),
  };
  const config = { get: () => secret } as unknown as ConfigService;
  const controller = new DiditController(realUserService, config);
  return { controller, userService };
}

function call(
  controller: DiditController,
  body: Record<string, unknown>,
  opts: { sign?: boolean; timestamp?: string; signature?: string } = {},
) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature =
    opts.signature ??
    (opts.sign === false
      ? undefined
      : createHmac('sha256', SECRET).update(raw).digest('hex'));
  return controller.handleWebhook(
    { rawBody: raw } as RawBodyRequest<Request>,
    body as unknown as WebhookDto,
    signature,
    opts.timestamp ?? now(),
  );
}

describe('DiditController webhook', () => {
  describe('signature', () => {
    it('accepts a valid X-Signature over the raw body', async () => {
      const { controller } = setup();
      await expect(
        call(controller, { session_id: 's1', status: 'Approved' }),
      ).resolves.toEqual({ success: true });
    });

    it('rejects a missing signature', async () => {
      const { controller, userService } = setup();
      await expect(
        call(
          controller,
          { session_id: 's1', status: 'Approved' },
          { sign: false },
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(userService.updateKycStatus).not.toHaveBeenCalled();
    });

    it('rejects a wrong signature', async () => {
      const { controller } = setup();
      await expect(
        call(
          controller,
          { session_id: 's1', status: 'Approved' },
          { signature: 'ab'.repeat(32) },
        ),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a stale timestamp', async () => {
      const { controller } = setup();
      const old = String(Math.floor(Date.now() / 1000) - 600);
      await expect(
        call(
          controller,
          { session_id: 's1', status: 'Approved' },
          { timestamp: old },
        ),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects everything in production when no secret is configured', async () => {
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const { controller } = setup('');
      await expect(
        call(
          controller,
          { session_id: 's1', status: 'Approved' },
          { sign: false },
        ),
      ).rejects.toBeInstanceOf(HttpException);
      process.env.NODE_ENV = env;
    });
  });

  describe('status handling', () => {
    it('Approved sets APPROVED with a verified date', async () => {
      const { controller, userService } = setup();
      await call(controller, { session_id: 's1', status: 'Approved' });
      expect(userService.updateKycStatus).toHaveBeenCalledWith('u1', {
        kyc_status: KycStatus.APPROVED,
        kyc_verified_at: expect.any(Date),
        kyc_rejection_reason: null,
      });
    });

    it('Declined stores the failure reason', async () => {
      const { controller, userService } = setup();
      await call(controller, {
        session_id: 's1',
        status: 'Declined',
        failure_reason: 'Document expired',
      });
      expect(userService.updateKycStatus).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          kyc_status: KycStatus.DECLINED,
          kyc_rejection_reason: 'Document expired',
        }),
      );
    });

    it('Resubmitted maps to IN_PROGRESS', async () => {
      const { controller, userService } = setup(SECRET, KycStatus.DECLINED);
      await call(controller, { session_id: 's1', status: 'Resubmitted' });
      expect(userService.updateKycStatus).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ kyc_status: KycStatus.IN_PROGRESS }),
      );
    });

    it('ignores a late "In Progress" after a final result', async () => {
      const { controller, userService } = setup(SECRET, KycStatus.APPROVED);
      await call(controller, { session_id: 's1', status: 'In Progress' });
      expect(userService.updateKycStatus).not.toHaveBeenCalled();
    });

    it('ignores unknown / KYB-only statuses', async () => {
      const { controller, userService } = setup();
      await call(controller, { session_id: 's1', status: 'Awaiting User' });
      expect(userService.updateKycStatus).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown session', async () => {
      const { controller, userService } = setup();
      userService.getUserByKycSessionId.mockResolvedValue(undefined);
      await expect(
        call(controller, { session_id: 'nope', status: 'Approved' }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
