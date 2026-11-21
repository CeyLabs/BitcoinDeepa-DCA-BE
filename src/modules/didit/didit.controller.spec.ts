import { HttpException, RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac } from 'crypto';
import { DiditController } from './didit.controller';
import { UserService } from '../user/user.service';
import { KycStatus } from '../user/enums/kyc-status.enum';
import { WebhookDto } from './dto/webhook.dto';
import { RedisService } from '../redis/redis.service';
import { DiditService } from './didit.service';

const SECRET = 'didit-secret';
const now = () => String(Math.floor(Date.now() / 1000));

function setup(secret = SECRET, currentStatus: string = KycStatus.IN_PROGRESS) {
  // Real UserService (it owns the status logic), database calls stubbed
  const telegramLogger = { logAlert: jest.fn().mockResolvedValue(undefined) };
  const realUserService = new UserService({} as never, telegramLogger as never);
  const userService = {
    getUserByKycSessionId: jest
      .spyOn(realUserService, 'getUserByKycSessionId')
      .mockResolvedValue({ id: 'u1', kyc_status: currentStatus } as never),
    updateKycStatus: jest
      .spyOn(realUserService, 'updateKycStatus')
      .mockResolvedValue(undefined),
  };
  const config = { get: () => secret } as unknown as ConfigService;
  // In-memory stand-in for the event_id claims
  const claimed = new Set<string>();
  const redis = {
    setIfAbsent: jest.fn((key: string) =>
      Promise.resolve(claimed.has(key) ? false : (claimed.add(key), true)),
    ),
    del: jest.fn((key: string) => Promise.resolve(void claimed.delete(key))),
  } as unknown as RedisService;
  // Didit's API: only used when an approval webhook carries no name
  const didit = {
    getSession: jest.fn().mockResolvedValue({
      status: 'Approved',
      url: null,
      verifiedName: 'Amal Perera',
    }),
  };
  const controller = new DiditController(
    realUserService,
    config,
    redis,
    didit as unknown as DiditService,
  );
  return { controller, userService, didit, telegramLogger };
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
    it('Approved sets APPROVED with a verified date and the name on the ID', async () => {
      const { controller, userService, didit } = setup();
      await call(controller, {
        session_id: 's1',
        status: 'Approved',
        decision: {
          id_verifications: [
            { full_name: 'Freja Nielsen', status: 'Approved' },
          ],
        },
      });
      expect(userService.updateKycStatus).toHaveBeenCalledWith('u1', {
        kyc_status: KycStatus.APPROVED,
        kyc_verified_at: expect.any(Date),
        kyc_rejection_reason: null,
        kyc_full_name: 'Freja Nielsen',
      });
      expect(didit.getSession).not.toHaveBeenCalled();
    });

    it('fetches the verified name from Didit when the webhook has none', async () => {
      const { controller, userService, didit } = setup();
      await call(controller, { session_id: 's1', status: 'Approved' });
      expect(didit.getSession).toHaveBeenCalledWith('s1');
      expect(userService.updateKycStatus).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ kyc_full_name: 'Amal Perera' }),
      );
    });

    it('clears the verified name when KYC is no longer approved', async () => {
      const { controller, userService } = setup(SECRET, KycStatus.APPROVED);
      await call(controller, {
        session_id: 's1',
        status: 'Declined',
        failure_reason: 'x',
      });
      expect(userService.updateKycStatus).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ kyc_full_name: null }),
      );
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

    it('Declined alerts the admins with the reason and issues', async () => {
      const { controller, telegramLogger } = setup();
      await call(controller, {
        session_id: 's1',
        status: 'Declined',
        failure_reason: 'Document expired',
        decision: {
          id_verifications: [
            {
              status: 'Declined',
              warnings: [
                {
                  risk: 'DOCUMENT_EXPIRED',
                  short_description: 'Document has expired',
                },
              ],
            },
          ],
          liveness_checks: [{ status: 'Approved', warnings: [] }],
        },
      });
      expect(telegramLogger.logAlert).toHaveBeenCalledTimes(1);
      const [source, text] = telegramLogger.logAlert.mock.calls[0] as [
        string,
        string,
      ];
      expect(source).toBe('KYC');
      expect(text).toContain('#UIDu1');
      expect(text).toContain('Reason: Document expired');
      expect(text).toContain('- ID: Document has expired');
      expect(text).toContain('Didit session: s1');
    });

    it('does not alert again when the user is already declined', async () => {
      const { controller, telegramLogger } = setup(SECRET, KycStatus.DECLINED);
      await call(controller, { session_id: 's1', status: 'Declined' });
      expect(telegramLogger.logAlert).not.toHaveBeenCalled();
    });

    it('a failing alert does not fail the webhook', async () => {
      const { controller, userService, telegramLogger } = setup();
      telegramLogger.logAlert.mockRejectedValue(new Error('telegram down'));
      await expect(
        call(controller, { session_id: 's1', status: 'Declined' }),
      ).resolves.toEqual({ success: true });
      expect(userService.updateKycStatus).toHaveBeenCalled();
    });

    it('does not alert for other results', async () => {
      const { controller, telegramLogger } = setup();
      await call(controller, { session_id: 's1', status: 'Abandoned' });
      expect(telegramLogger.logAlert).not.toHaveBeenCalled();
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
