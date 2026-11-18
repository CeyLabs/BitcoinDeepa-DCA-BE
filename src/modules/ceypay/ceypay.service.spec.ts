import axios from 'axios';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign,
  KeyObject,
} from 'crypto';
import { CeyPayError, CeyPayService } from './ceypay.service';

const request = jest.spyOn(axios, 'request');

describe('CeyPayService', () => {
  let service: CeyPayService;
  let privateKey: KeyObject;

  beforeEach(() => {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    process.env.CEYPAY_API_URL = 'https://ceypay.test/';
    process.env.CEYPAY_API_KEY_ID = 'ak_live_key';
    process.env.CEYPAY_API_SECRET = 'sk_live_secret';
    process.env.CEYPAY_WEBHOOK_PUBLIC_KEY = pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    service = new CeyPayService();
    request.mockReset();
  });

  describe('request signing', () => {
    const signingKey = createHash('sha256')
      .update('sk_live_secret')
      .digest('hex');

    it('signs timestamp + METHOD + path + body with sha256(secret) as the key', async () => {
      request.mockResolvedValue({ data: { paymentId: 'p1' } });
      const body = {
        fxLockId: 'f',
        userId: 'u',
        userBankId: 'b',
        externalRef: 'e',
      };
      await service.createOfframp(body);

      const config = request.mock.calls[0][0];
      const headers = config.headers as Record<string, string>;
      expect(config.url).toBe('https://ceypay.test/v1/aggregator/offramp');
      expect(config.data).toBe(JSON.stringify(body));
      expect(headers['x-api-key']).toBe('ak_live_key');
      const expected = createHmac('sha256', signingKey)
        .update(
          `${headers['x-timestamp']}POST/v1/aggregator/offramp${JSON.stringify(body)}`,
        )
        .digest('hex');
      expect(headers['x-signature']).toBe(expected);
    });

    it('signs the query string and an empty body on GET', async () => {
      request.mockResolvedValue({ data: {} });
      await service.getQuote('12.5');

      const config = request.mock.calls[0][0];
      const headers = config.headers as Record<string, string>;
      expect(config.data).toBeUndefined();
      const expected = createHmac('sha256', signingKey)
        .update(
          `${headers['x-timestamp']}GET/v1/aggregator/quote?amount_usdt=12.5`,
        )
        .digest('hex');
      expect(headers['x-signature']).toBe(expected);
    });
  });

  describe('error classification', () => {
    it.each([
      [undefined, true],
      [500, true],
      [503, true],
      [429, true],
      [400, false],
      [404, false],
      [422, false],
    ])('HTTP %s -> outcomeUnknown=%s', async (status, unknown) => {
      request.mockRejectedValue(
        status
          ? {
              message: 'x',
              response: { status, data: { message: 'Insufficient float' } },
            }
          : new Error('timeout'),
      );
      const error = await service.getOfframp('p1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CeyPayError);
      expect((error as CeyPayError).outcomeUnknown).toBe(unknown);
      expect((error as CeyPayError).status).toBe(status);
    });

    it('fails fast when not configured', async () => {
      process.env.CEYPAY_API_SECRET = '';
      await expect(new CeyPayService().getBanks()).rejects.toMatchObject({
        outcomeUnknown: false,
      });
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('verifyWebhookSignature', () => {
    const body = JSON.stringify({
      event: 'payment.completed',
      paymentId: 'p1',
    });
    const signed = (ts: string, raw = body) =>
      sign(null, Buffer.from(`${ts}${raw}`), privateKey).toString('base64');

    it('accepts a valid ED25519 signature over timestamp + raw body', () => {
      const ts = String(Date.now());
      expect(
        service.verifyWebhookSignature(Buffer.from(body), ts, signed(ts)),
      ).toBe(true);
    });

    it('accepts a single-line base64 DER public key', () => {
      const pair = generateKeyPairSync('ed25519');
      process.env.CEYPAY_WEBHOOK_PUBLIC_KEY = pair.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64');
      const ts = String(Date.now());
      const sig = sign(null, Buffer.from(`${ts}${body}`), pair.privateKey);
      expect(
        new CeyPayService().verifyWebhookSignature(
          body,
          ts,
          sig.toString('base64'),
        ),
      ).toBe(true);
    });

    it('rejects a tampered body', () => {
      const ts = String(Date.now());
      expect(
        service.verifyWebhookSignature(
          Buffer.from(body.replace('p1', 'p2')),
          ts,
          signed(ts),
        ),
      ).toBe(false);
    });

    it('rejects a stale timestamp', () => {
      const ts = String(Date.now() - 6 * 60_000);
      expect(service.verifyWebhookSignature(body, ts, signed(ts))).toBe(false);
    });

    it('rejects missing headers or a garbage signature', () => {
      const ts = String(Date.now());
      expect(service.verifyWebhookSignature(body, undefined, 'x')).toBe(false);
      expect(service.verifyWebhookSignature(body, ts, undefined)).toBe(false);
      expect(service.verifyWebhookSignature(body, ts, 'not-base64!')).toBe(
        false,
      );
    });
  });
});
