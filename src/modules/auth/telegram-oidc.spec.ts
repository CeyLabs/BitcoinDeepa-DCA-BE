import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

// jose is ESM-only; load it the same way auth.service does. Needs
// --experimental-vm-modules (set in the package.json test scripts).
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importJose = new Function('return import("jose")') as () => Promise<
  typeof import('jose')
>;

const ISSUER = 'https://oauth.telegram.org';
const CLIENT_ID = '1234567890';

describe('AuthService.verifyTelegramOidcIdToken', () => {
  const service = new AuthService(new JwtService({ secret: 'test' }));
  let jose: typeof import('jose');
  let telegramKey: CryptoKey;
  let fetchSpy: jest.SpyInstance;

  /** An id_token signed like Telegram signs it, with overridable parts. */
  async function idToken(
    claims: Record<string, unknown> = {},
    opts: {
      key?: CryptoKey;
      kid?: string;
      iss?: string;
      aud?: string;
      exp?: string | number;
    } = {},
  ) {
    return new jose.SignJWT({
      id: '100000001',
      name: 'Test User',
      preferred_username: 'tester',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'tg-1' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(opts.key ?? telegramKey);
  }

  beforeAll(async () => {
    jose = await importJose();
    const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
    telegramKey = privateKey;
    const jwk = {
      ...(await jose.exportJWK(publicKey)),
      kid: 'tg-1',
      alg: 'RS256',
    };

    // Telegram's JWKS endpoint, served locally
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(Response.json({ keys: [jwk] })),
      );
  });
  afterAll(() => fetchSpy.mockRestore());

  it('accepts a valid token and returns the Telegram id as a string', async () => {
    const claims = await service.verifyTelegramOidcIdToken(
      await idToken(),
      CLIENT_ID,
    );
    expect(claims).toMatchObject({
      id: '100000001',
      preferred_username: 'tester',
    });
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://oauth.telegram.org/.well-known/jwks.json',
    );
  });

  it('accepts a numeric id claim', async () => {
    const claims = await service.verifyTelegramOidcIdToken(
      await idToken({ id: 100000001 }),
      CLIENT_ID,
    );
    expect(claims.id).toBe('100000001');
  });

  it.each([
    ['another app (audience)', () => idToken({}, { aud: '999' })],
    ['another issuer', () => idToken({}, { iss: 'https://evil.example' })],
    [
      'an expired token',
      () => idToken({}, { exp: Math.floor(Date.now() / 1000) - 60 }),
    ],
    ['garbage', () => Promise.resolve('not.a.jwt')],
  ])('rejects %s', async (_, makeToken) => {
    await expect(
      service.verifyTelegramOidcIdToken(await makeToken(), CLIENT_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['a missing id claim', () => idToken({ id: undefined })],
    ['a non-numeric id', () => idToken({ id: 'admin' })],
  ])(
    'refuses %s as missing_telegram_id (never falls back to sub)',
    async (_, makeToken) => {
      await expect(
        service.verifyTelegramOidcIdToken(await makeToken(), CLIENT_ID),
      ).rejects.toMatchObject({
        response: { code: 'missing_telegram_id' },
      });
    },
  );

  it('rejects a token signed with a key that is not in Telegram JWKS', async () => {
    const { privateKey } = await jose.generateKeyPair('RS256');
    for (const kid of ['tg-1', 'other']) {
      await expect(
        service.verifyTelegramOidcIdToken(
          await idToken({}, { key: privateKey, kid }),
          CLIENT_ID,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('rejects a token using a symmetric algorithm (alg confusion)', async () => {
    const token = await new jose.SignJWT({ id: '100000001' })
      .setProtectedHeader({ alg: 'HS256', kid: 'tg-1' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('guessed-secret-guessed-secret-32b'));
    await expect(
      service.verifyTelegramOidcIdToken(token, CLIENT_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
