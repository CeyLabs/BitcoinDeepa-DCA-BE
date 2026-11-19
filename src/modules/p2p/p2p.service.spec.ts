import { HttpException } from '@nestjs/common';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { LOGIN_INIT_TIMEOUT_MS, P2pService } from './p2p.service';
import type { P2pBotClient } from './p2p-bot.client';
import type { RedisService } from '../redis/redis.service';
import type { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import type { UserService } from '../user/user.service';

/** Login only: the fresh Telegram credential for /api/v1/init */
const credential = { kind: 'initData' as const, value: 'init' };
/** Every other call: our session names the user (X-BDB-User, V2) */
const asUser = { kind: 'user' as const, telegramId: '42' };

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
  const redis = { setIfAbsent: jest.fn(), del: jest.fn() };
  const telegramLogger = { logAlert: jest.fn().mockResolvedValue(undefined) };
  const users = { getUserByUsername: jest.fn() };
  const service = new P2pService(
    bot as unknown as P2pBotClient,
    redis as unknown as RedisService,
    telegramLogger as unknown as TelegramLoggerService,
    users as unknown as UserService,
  );
  const send = (extra = {}) =>
    service.send('42', {
      to_telegram_id: 7,
      amount: 100,
      idempotency_key: 'key-12345',
      ...extra,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    bot.isConfigured.mockReturnValue(true);
    redis.setIfAbsent.mockResolvedValue(true);
  });

  it('sends exactly the documented fields (memo only when given) as the session user', async () => {
    bot.request.mockResolvedValue({
      status: 202,
      body: { id: 'p2p-a', status: 'awaiting_confirmation' },
    });
    await expect(send()).resolves.toEqual({
      status: 202,
      body: { id: 'p2p-a', status: 'awaiting_confirmation' },
    });
    expect(bot.request).toHaveBeenCalledWith(
      'POST',
      '/api/v1/p2p/send',
      asUser,
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

  describe('resolveRecipient (our usernames, from the DB)', () => {
    it('finds a member by @username without calling the bot', async () => {
      users.getUserByUsername.mockResolvedValue({
        id: '7',
        first_name: 'Telegram',
        last_name: 'Name',
        kyc_full_name: 'Nimal Silva Fernando',
        avatar_seed: 'abc',
      });
      const result = await service.resolveRecipient('42', { to: ' @Nimal ' });
      expect(users.getUserByUsername).toHaveBeenCalledWith('nimal');
      expect(bot.request).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 200,
        body: {
          telegram_id: 7,
          username: 'nimal',
          name: 'Nimal S.',
          avatar_seed: 'abc',
        },
      });
    });

    it('404 when no one has it, 400 for a bad name or yourself', async () => {
      users.getUserByUsername.mockResolvedValue(undefined);
      expect(
        await errorOf(service.resolveRecipient('42', { to: 'nobody' })),
      ).toMatchObject({ status: 404, body: { code: 'recipient_not_found' } });
      expect(
        await errorOf(service.resolveRecipient('42', { to: '1bad' })),
      ).toMatchObject({ status: 400, body: { code: 'invalid_username' } });
      users.getUserByUsername.mockResolvedValue({ id: '42' });
      expect(
        await errorOf(service.resolveRecipient('42', { to: 'me_me' })),
      ).toMatchObject({ status: 400, body: { code: 'cannot_send_to_self' } });
    });
  });

  it("passes the bot's own 4xx through (user-facing message)", async () => {
    bot.request.mockResolvedValue({
      status: 404,
      body: {
        code: 'recipient_not_found',
        message: 'No Bitcoin Deepa user found.',
      },
    });
    expect(await errorOf(send())).toEqual({
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

  it('a user the bot has not linked (403 login_required) becomes our 403 relogin_required (not a sign-out 401)', async () => {
    bot.request.mockResolvedValue({
      status: 403,
      body: { code: 'login_required', message: 'Log in first.' },
    });
    expect(await errorOf(send())).toMatchObject({
      status: 403,
      body: { code: 'relogin_required' },
    });
    expect(telegramLogger.logAlert).not.toHaveBeenCalled();
  });

  it('a 401 on an X-BDB-User call is our bug: 502 p2p_unavailable + alert', async () => {
    bot.request.mockResolvedValue({
      status: 401,
      body: { code: 'unauthorized', message: 'x' },
    });
    expect(await errorOf(send())).toMatchObject({
      status: 502,
      body: { code: 'p2p_unavailable' },
    });
    expect(telegramLogger.logAlert).toHaveBeenCalled();
  });

  it('init: the bot refusing the Telegram credential (401) is 403 credential_rejected', async () => {
    bot.request.mockResolvedValue({
      status: 401,
      body: { code: 'unauthorized', message: 'Log in again.' },
    });
    expect(await errorOf(service.init('42', credential, {}))).toEqual({
      status: 403,
      body: { code: 'credential_rejected', message: 'Log in again.' },
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
    expect(await errorOf(service.me('42'))).toEqual({
      status: 503,
      body: {
        code: 'balance_unavailable',
        message: 'Could not load your balance. Try again.',
      },
    });
    bot.request.mockRejectedValue(new Error('ECONNRESET'));
    expect(await errorOf(service.transfer('42', 'p2p-ab'))).toMatchObject({
      status: 503,
      body: { code: 'p2p_unavailable' },
    });
  });

  it('/me, transfers and collect approve name the session user, never a Telegram credential', async () => {
    bot.request.mockResolvedValue({ status: 200, body: { balance: 5 } });
    await expect(service.me('42')).resolves.toEqual({
      status: 200,
      body: { balance: 5 },
    });
    await service.transfer('42', 'p2p-ab');
    await service.approveCollect('42', 'col-1');
    expect(
      (bot.request.mock.calls as unknown[][]).map((c) => [c[1], c[2]]),
    ).toEqual([
      ['/api/v1/p2p/me', asUser],
      ['/api/v1/p2p/transfers/p2p-ab', asUser],
      ['/api/v1/p2p/collect/col-1/approve', asUser],
    ]);
  });

  it('init forwards the login credential and only referral_code to /api/v1/init', async () => {
    bot.request.mockResolvedValue({
      status: 201,
      body: { telegram_id: 42, created: true, can_message: false },
    });
    await expect(
      service.init('42', credential, { referral_code: 'PROMO2024' }),
    ).resolves.toEqual({
      status: 201,
      body: { telegram_id: 42, created: true, can_message: false },
    });
    expect(bot.request).toHaveBeenCalledWith(
      'POST',
      '/api/v1/init',
      credential,
      { referral_code: 'PROMO2024' },
      LOGIN_INIT_TIMEOUT_MS,
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
    await expect(service.init('42', credential, {})).resolves.toMatchObject({
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
    expect(await errorOf(service.init('42', credential, {}))).toEqual({
      status: 403,
      body: { code: 'sender_not_allowed', message: 'Not allowed.' },
    });
    bot.request.mockResolvedValue({
      status: 503,
      body: { code: 'wallet_unavailable', message: 'Retry.' },
    });
    expect(await errorOf(service.init('42', credential, {}))).toEqual({
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
