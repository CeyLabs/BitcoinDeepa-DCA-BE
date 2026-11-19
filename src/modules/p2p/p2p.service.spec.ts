import { HttpException } from '@nestjs/common';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { P2pService } from './p2p.service';
import type { P2pBotClient } from './p2p-bot.client';
import type { P2pCredentialService } from './p2p-credential.service';
import type { RedisService } from '../redis/redis.service';
import type { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';

const credential = { kind: 'initData' as const, value: 'init' };

async function errorOf(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      body: err.getResponse() as Record<string, unknown>,
    };
  }
  throw new Error('expected an error');
}

describe('P2pService', () => {
  const bot = { isConfigured: jest.fn(), request: jest.fn() };
  const credentials = { resolve: jest.fn() };
  const redis = { setIfAbsent: jest.fn(), del: jest.fn() };
  const telegramLogger = { logAlert: jest.fn().mockResolvedValue(undefined) };
  const service = new P2pService(
    bot as unknown as P2pBotClient,
    credentials as unknown as P2pCredentialService,
    redis as unknown as RedisService,
    telegramLogger as unknown as TelegramLoggerService,
  );
  const send = (extra = {}) =>
    service.send('42', 'init', {
      to_telegram_id: 7,
      amount: 100,
      idempotency_key: 'key-12345',
      ...extra,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    bot.isConfigured.mockReturnValue(true);
    credentials.resolve.mockResolvedValue({
      credential,
      platform: 'mini_app',
      issuedAt: 1_700_000_000,
    });
    redis.setIfAbsent.mockResolvedValue(true);
  });

  it('sends exactly the documented fields (memo only when given) with a spend credential', async () => {
    bot.request.mockResolvedValue({
      status: 202,
      body: { id: 'p2p-a', status: 'awaiting_confirmation' },
    });
    await expect(send()).resolves.toEqual({
      status: 202,
      body: { id: 'p2p-a', status: 'awaiting_confirmation' },
    });
    expect(credentials.resolve).toHaveBeenCalledWith('42', 'init', 'spend');
    expect(bot.request).toHaveBeenCalledWith(
      'POST',
      '/api/v1/p2p/send',
      credential,
      {
        to_telegram_id: 7,
        amount: 100,
        idempotency_key: 'key-12345',
      },
    );
    await send({ memo: 'lunch' });
    expect(bot.request.mock.calls[1][3]).toMatchObject({ memo: 'lunch' });
  });

  it('clears both wallet summaries after a completed send', async () => {
    bot.request.mockResolvedValue({
      status: 200,
      body: { id: 'p2p-a', status: 'completed' },
    });
    await send();
    expect(redis.del).toHaveBeenCalledWith(
      CacheKeys.transaction.dcaSummary('42'),
    );
    expect(redis.del).toHaveBeenCalledWith(
      CacheKeys.transaction.dcaSummary('7'),
    );
  });

  it("passes the bot's own 4xx through (user-facing message)", async () => {
    bot.request.mockResolvedValue({
      status: 404,
      body: {
        code: 'recipient_not_found',
        message: 'No Bitcoin Deepa user found.',
      },
    });
    expect(
      await errorOf(service.resolveRecipient('42', 'init', { to: '@x' })),
    ).toEqual({
      status: 404,
      body: {
        code: 'recipient_not_found',
        message: 'No Bitcoin Deepa user found.',
      },
    });
  });

  it.each([
    [
      'a bad service signature',
      401,
      { code: 'bad_service_signature', message: 'x' },
    ],
    ['the P2P IP allowlist', 403, { code: 'forbidden', message: 'x' }],
    ['the global IP allowlist (plain text)', 403, 'Access denied'],
  ])(
    'maps %s to 502 p2p_unavailable and alerts (hourly)',
    async (_, status, body) => {
      bot.request.mockResolvedValue({ status, body });
      expect(await errorOf(send())).toMatchObject({
        status: 502,
        body: { code: 'p2p_unavailable' },
      });
      expect(telegramLogger.logAlert).toHaveBeenCalledWith(
        'P2P',
        expect.stringContaining('P2P sends are failing'),
      );
      redis.setIfAbsent.mockResolvedValue(false);
      await errorOf(send());
      expect(telegramLogger.logAlert).toHaveBeenCalledTimes(1);
    },
  );

  it("the bot refusing the user's credential (401) becomes 403 credential_rejected (our session is fine)", async () => {
    bot.request.mockResolvedValue({
      status: 401,
      body: {
        code: 'unauthorized',
        message: 'Your session expired. Close and reopen the Mini App.',
      },
    });
    expect(await errorOf(send())).toEqual({
      status: 403,
      body: {
        code: 'credential_rejected',
        message: 'Your session expired. Close and reopen the Mini App.',
      },
    });
    expect(telegramLogger.logAlert).not.toHaveBeenCalled();
  });

  it('a send with no answer or a 5xx is outcome_unknown (502)', async () => {
    bot.request.mockRejectedValue(new Error('timeout'));
    expect(await errorOf(send())).toMatchObject({
      status: 502,
      body: { code: 'outcome_unknown' },
    });
    bot.request.mockResolvedValue({
      status: 500,
      body: { code: 'internal_error', message: 'x' },
    });
    expect(await errorOf(send())).toMatchObject({
      status: 502,
      body: { code: 'outcome_unknown' },
    });
  });

  it("a read's 5xx is 503, keeping /me's balance_unavailable message", async () => {
    bot.request.mockResolvedValue({
      status: 503,
      body: {
        code: 'balance_unavailable',
        message: 'Could not load your balance. Try again.',
      },
    });
    expect(await errorOf(service.me('42', 'init'))).toEqual({
      status: 503,
      body: {
        code: 'balance_unavailable',
        message: 'Could not load your balance. Try again.',
      },
    });
    bot.request.mockRejectedValue(new Error('ECONNRESET'));
    expect(
      await errorOf(service.transfer('42', 'init', 'p2p-ab')),
    ).toMatchObject({
      status: 503,
      body: { code: 'p2p_unavailable' },
    });
  });

  it('/me adds when the credential stops being fresh enough to send', async () => {
    bot.request.mockResolvedValue({ status: 200, body: { balance: 5 } });
    await expect(service.me('42', 'init')).resolves.toEqual({
      status: 200,
      body: {
        balance: 5,
        credential: {
          platform: 'mini_app',
          spend_fresh_until: new Date(
            (1_700_000_000 + 570) * 1000,
          ).toISOString(),
        },
      },
    });
    expect(credentials.resolve).toHaveBeenCalledWith('42', 'init', 'read');
  });

  it('init forwards only referral_code to /api/v1/init with a read credential', async () => {
    bot.request.mockResolvedValue({
      status: 201,
      body: { telegram_id: 42, created: true, can_message: false },
    });
    await expect(
      service.init('42', 'init', { referral_code: 'PROMO2024' }),
    ).resolves.toEqual({
      status: 201,
      body: { telegram_id: 42, created: true, can_message: false },
    });
    expect(credentials.resolve).toHaveBeenCalledWith('42', 'init', 'read');
    expect(bot.request).toHaveBeenCalledWith(
      'POST',
      '/api/v1/init',
      credential,
      { referral_code: 'PROMO2024' },
    );
    expect(redis.del).toHaveBeenCalledWith(
      CacheKeys.transaction.dcaSummary('42'),
    );
  });

  it('init for an existing wallet sends {} and keeps the cache', async () => {
    bot.request.mockResolvedValue({
      status: 200,
      body: { telegram_id: 42, created: false },
    });
    await expect(service.init('42', 'init', {})).resolves.toMatchObject({
      status: 200,
    });
    expect(bot.request.mock.calls[0][3]).toEqual({});
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("init passes the bot's refusals through (sender_not_allowed, wallet_unavailable)", async () => {
    bot.request.mockResolvedValue({
      status: 403,
      body: { code: 'sender_not_allowed', message: 'Not allowed.' },
    });
    expect(await errorOf(service.init('42', 'init', {}))).toEqual({
      status: 403,
      body: { code: 'sender_not_allowed', message: 'Not allowed.' },
    });
    bot.request.mockResolvedValue({
      status: 503,
      body: { code: 'wallet_unavailable', message: 'Retry.' },
    });
    expect(await errorOf(service.init('42', 'init', {}))).toEqual({
      status: 503,
      body: { code: 'wallet_unavailable', message: 'Retry.' },
    });
  });

  it('503 when the P2P key or bot URL is missing', async () => {
    bot.isConfigured.mockReturnValue(false);
    expect(await errorOf(send())).toMatchObject({
      status: 503,
      body: { code: 'p2p_unavailable' },
    });
    expect(bot.request).not.toHaveBeenCalled();
  });
});
