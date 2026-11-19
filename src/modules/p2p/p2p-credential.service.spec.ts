import { HttpException } from '@nestjs/common';
import {
  P2pCredentialService,
  parseInitData,
  spendFreshUntil,
} from './p2p-credential.service';
import type { WebIdTokenStore } from '../auth/web-id-token.store';

const now = () => Math.floor(Date.now() / 1000);
const initData = (userId: number, authDate: number) =>
  new URLSearchParams({
    query_id: 'q',
    user: JSON.stringify({ id: userId, first_name: 'A' }),
    auth_date: String(authDate),
    hash: 'h',
  }).toString();

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

describe('parseInitData', () => {
  it('reads user.id and auth_date', () => {
    expect(parseInitData(initData(42, 1700000000))).toEqual({
      userId: '42',
      authDate: 1700000000,
    });
  });
  it.each([['garbage'], ['user=notjson&auth_date=1'], [initData(42, 0)]])(
    'is null for %s',
    (raw) => expect(parseInitData(raw)).toBeNull(),
  );
});

describe('P2pCredentialService', () => {
  const store = { isAvailable: jest.fn(), get: jest.fn() };
  const service = new P2pCredentialService(store as unknown as WebIdTokenStore);
  beforeEach(() => {
    store.isAvailable.mockReturnValue(true);
    store.get.mockResolvedValue(null);
  });

  describe('Mini App (initData header)', () => {
    it('forwards it unchanged for the signed-in user', async () => {
      const raw = initData(42, now() - 60);
      await expect(service.resolve('42', raw, 'spend')).resolves.toEqual({
        credential: { kind: 'initData', value: raw },
        platform: 'mini_app',
        issuedAt: now() - 60,
      });
    });

    it("refuses another user's initData (403)", async () => {
      const err = await errorOf(
        service.resolve('42', initData(7, now()), 'read'),
      );
      expect(err).toMatchObject({
        status: 403,
        body: { code: 'credential_mismatch' },
      });
    });

    it('refuses unreadable initData (400)', async () => {
      expect(await errorOf(service.resolve('42', 'x', 'read'))).toMatchObject({
        status: 400,
        body: { code: 'invalid_credential' },
      });
    });

    it('a send needs it under 10 min old (with a margin); a read under 1 h', async () => {
      const raw = initData(42, now() - 9 * 60 - 40); // 9m40s
      expect(await errorOf(service.resolve('42', raw, 'spend'))).toMatchObject({
        status: 403,
        body: { code: 'credential_stale', platform: 'mini_app' },
      });
      await expect(service.resolve('42', raw, 'read')).resolves.toBeDefined();
      expect(
        await errorOf(
          service.resolve('42', initData(42, now() - 3600), 'read'),
        ),
      ).toMatchObject({ status: 403 });
    });
  });

  describe('web (stored id_token)', () => {
    it('uses the stored login', async () => {
      store.get.mockResolvedValue({ token: 'jwt', iat: now() - 30 });
      await expect(
        service.resolve('42', undefined, 'spend'),
      ).resolves.toMatchObject({
        credential: { kind: 'idToken', value: 'jwt' },
        platform: 'web',
      });
      expect(store.get).toHaveBeenCalledWith('42');
    });

    it('asks for a fresh login when there is none or it is too old', async () => {
      expect(
        await errorOf(service.resolve('42', undefined, 'read')),
      ).toMatchObject({
        status: 403,
        body: { code: 'credential_stale', platform: 'web' },
      });
      store.get.mockResolvedValue({ token: 'jwt', iat: now() - 11 * 60 });
      expect(
        await errorOf(service.resolve('42', undefined, 'spend')),
      ).toMatchObject({
        status: 403,
        body: { platform: 'web' },
      });
    });

    it('503 without Redis (nothing can be kept server-side)', async () => {
      store.isAvailable.mockReturnValue(false);
      expect(
        await errorOf(service.resolve('42', undefined, 'read')),
      ).toMatchObject({
        status: 503,
        body: { code: 'p2p_unavailable' },
      });
    });
  });

  it('spendFreshUntil is 9.5 min after issue', () => {
    expect(spendFreshUntil(1000)).toBe(1000 + 570);
  });
});
