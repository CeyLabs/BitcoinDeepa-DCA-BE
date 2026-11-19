import * as request from 'supertest';
import { createHmac } from 'crypto';
import {
  createTestApp,
  resetData,
  TestContext,
  USER,
} from './support/test-app';
import { AuthService } from '../src/modules/auth/auth.service';
import type { TelegramOidcClaims } from '../src/modules/auth/auth.service';
import { AUTH_RATE_LIMITS } from '../src/modules/auth/auth-rate-limiter';
import { LOGIN_INIT_TIMEOUT_MS } from '../src/modules/p2p/p2p.service';
import { SessionService } from '../src/modules/auth/session.service';

const APP = 'https://app.example.test';
const CLIENT_ID = '8219648988';

/** Mini App initData signed the way Telegram does */
function signedInitData(userId = USER, ageSeconds = 5): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
    user: JSON.stringify({ id: Number(userId), first_name: 'Mini' }),
  };
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN!)
    .digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** "name=value" of a Set-Cookie header, or undefined */
function cookieFrom(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0];
}

describe('User sessions (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const env: Record<string, string | undefined> = {};

  const miniAppLogin = async (userId = USER) => {
    const res = await http()
      .post('/auth/telegram/miniapp')
      .send({ initData: signedInitData(userId) })
      .expect(200);
    return res.body as { token: string; walletLinked: boolean };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(async () => {
    await resetData(ctx);
    ctx.p2pBot.isConfigured.mockReturnValue(true);
    ctx.p2pBot.request.mockReset();
    ctx.p2pBot.request.mockResolvedValue({
      status: 201,
      body: { telegram_id: Number(USER), created: true, can_message: false },
    });
    for (const key of [
      'APP_URL',
      'TELEGRAM_OIDC_CLIENT_ID',
      'TELEGRAM_OIDC_CLIENT_SECRET',
      'LEGACY_JWT_ISSUE',
    ]) {
      env[key] = process.env[key];
    }
    process.env.APP_URL = APP;
    process.env.TELEGRAM_OIDC_CLIENT_ID = CLIENT_ID;
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = 'secret';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('Mini App: initData exchanged once at launch', () => {
    it('creates a session, links the wallet on the bot with that initData, and the token works', async () => {
      // Not a fixture user, so this login registers them
      const NEW_USER = '100000777';
      const initData = signedInitData(NEW_USER);
      const res = await http()
        .post('/auth/telegram/miniapp')
        .send({ initData, referral_code: 'PROMO2024' })
        .expect(200);
      expect(res.body).toMatchObject({
        user: { telegram_id: NEW_USER },
        isRegistered: false,
        walletLinked: true,
        canMessage: false,
      });
      expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(res.body)).not.toContain(initData);
      expect(ctx.p2pBot.request).toHaveBeenCalledWith(
        'POST',
        '/api/v1/init',
        { kind: 'initData', value: initData },
        { referral_code: 'PROMO2024' },
        LOGIN_INIT_TIMEOUT_MS,
      );

      const auth = { Authorization: `Bearer ${res.body.token}` };
      const me = await http().get('/auth/me').set(auth).expect(200);
      expect(me.body).toMatchObject({
        user: { telegram_id: NEW_USER },
        session: { kind: 'miniapp' },
      });
      await http().get('/user/me').set(auth).expect(200);

      // A returning user is registered
      const again = await http()
        .post('/auth/telegram/miniapp')
        .send({ initData })
        .expect(200);
      expect(again.body.isRegistered).toBe(true);

      const row = await ctx
        .knex('user_session')
        .where({ user_id: NEW_USER })
        .orderBy('created_at')
        .first();
      expect(row.kind).toBe('miniapp');
      // only the hash is stored
      expect(Buffer.from(row.token_hash).toString('base64url')).not.toBe(
        res.body.token,
      );
    });

    it('refuses initData older than 15 minutes, or a bad signature', async () => {
      await http()
        .post('/auth/telegram/miniapp')
        .send({ initData: signedInitData(USER, 16 * 60) })
        .expect(401);
      await http()
        .post('/auth/telegram/miniapp')
        .send({ initData: signedInitData().replace('Mini', 'Evil') })
        .expect(401);
      expect(ctx.p2pBot.request).not.toHaveBeenCalled();
    });

    it('still logs in when the bot is down (walletLinked: false)', async () => {
      ctx.p2pBot.request.mockRejectedValue(new Error('timeout'));
      const body = await miniAppLogin();
      expect(body.walletLinked).toBe(false);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${body.token}`)
        .expect(200);
    });

    it(`rate-limits each Telegram user (${AUTH_RATE_LIMITS.miniappUser}/min), not a shared IP, and never /auth/me`, async () => {
      let token = '';
      for (let i = 0; i < AUTH_RATE_LIMITS.miniappUser; i++) {
        token = (await miniAppLogin()).token;
      }
      const limited = await http()
        .post('/auth/telegram/miniapp')
        .send({ initData: signedInitData() })
        .expect(429);
      expect(limited.body.code).toBe('rate_limited');
      // Same IP, another user: still fine
      await miniAppLogin('100000777');
      for (let i = 0; i < 30; i++) {
        await http()
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      }
    });
  });

  describe('web: Log In with Telegram (OIDC redirect + PKCE)', () => {
    const startLogin = async (returnTo = '/wallet') => {
      const res = await http()
        .get('/auth/telegram/start')
        .query({ return_to: returnTo, ref: 'PROMO2024' })
        .expect(302);
      const url = new URL(res.headers.location);
      return { res, url, attempt: cookieFrom(res, 'tg_attempt') };
    };

    const mockTelegram = (claims: Partial<TelegramOidcClaims> = {}) => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id_token: 'tg.id.token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const verify = jest
        .spyOn(ctx.app.get(AuthService), 'verifyTelegramOidcIdToken')
        .mockResolvedValue({
          id: USER,
          sub: 'sub-abc',
          given_name: 'Web',
          ...claims,
        } as TelegramOidcClaims);
      return { fetchSpy, verify };
    };

    it('start sends the browser to Telegram with PKCE S256 and a single-use attempt cookie', async () => {
      const { res, url, attempt } = await startLogin();
      expect(url.origin + url.pathname).toBe('https://oauth.telegram.org/auth');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: CLIENT_ID,
        redirect_uri: 'https://example.test/auth/telegram/callback',
        response_type: 'code',
        scope: 'openid profile',
        code_challenge_method: 'S256',
      });
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(attempt).toBeTruthy();
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).not.toContain('Domain=');
    });

    it('APP_COOKIE_SAME_SITE=none makes the cookies SameSite=None; Secure (cross-site dev)', async () => {
      process.env.APP_COOKIE_SAME_SITE = 'none';
      try {
        const { res } = await startLogin();
        const setCookie = String(res.headers['set-cookie']);
        expect(setCookie).toContain('SameSite=None');
        expect(setCookie).toContain('Secure');
      } finally {
        delete process.env.APP_COOKIE_SAME_SITE;
      }
    });

    it('gives the app origin credentialed CORS, other origins none', async () => {
      const app = await http().get('/package').set('Origin', APP);
      expect(app.headers['access-control-allow-origin']).toBe(APP);
      expect(app.headers['access-control-allow-credentials']).toBe('true');
      const other = await http()
        .get('/package')
        .set('Origin', 'https://evil.example');
      expect(other.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('callback: exchanges the code, links the wallet with the id_token, sets the session cookie, returns', async () => {
      const { url, attempt } = await startLogin('/wallet?tab=send');
      const { fetchSpy, verify } = mockTelegram();

      const res = await http()
        .get('/auth/telegram/callback')
        .query({ code: 'the-code', state: url.searchParams.get('state') })
        .set('Cookie', attempt!)
        .expect(302);
      expect(res.headers.location).toBe(`${APP}/wallet?tab=send`);

      const [tokenUrl, init] = fetchSpy.mock.calls[0];
      expect(tokenUrl).toBe('https://oauth.telegram.org/token');
      const body = new URLSearchParams(init?.body as URLSearchParams);
      expect(body.get('code')).toBe('the-code');
      expect(body.get('code_verifier')).toBeTruthy();
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from(`${CLIENT_ID}:secret`).toString('base64')}`,
      );
      expect(verify).toHaveBeenCalledWith('tg.id.token', CLIENT_ID);
      expect(ctx.p2pBot.request).toHaveBeenCalledWith(
        'POST',
        '/api/v1/init',
        { kind: 'idToken', value: 'tg.id.token' },
        { referral_code: 'PROMO2024' },
        LOGIN_INIT_TIMEOUT_MS,
      );

      const sid = cookieFrom(res, 'sid');
      expect(sid).toBeTruthy();
      const me = await http().get('/auth/me').set('Cookie', sid!).expect(200);
      expect(me.body.session.kind).toBe('web');
      expect(await ctx.knex('user').where({ id: USER }).first()).toMatchObject({
        telegram_sub: 'sub-abc',
      });
    });

    it('an attempt works once; a wrong state or a missing id claim fails to the login page', async () => {
      const first = await startLogin();
      mockTelegram();
      const state = first.url.searchParams.get('state');
      await http()
        .get('/auth/telegram/callback')
        .query({ code: 'c', state })
        .set('Cookie', first.attempt!)
        .expect(302);
      const replay = await http()
        .get('/auth/telegram/callback')
        .query({ code: 'c', state })
        .set('Cookie', first.attempt!)
        .expect(302);
      expect(replay.headers.location).toBe(
        `${APP}/?login_error=attempt_expired`,
      );

      const second = await startLogin();
      const bad = await http()
        .get('/auth/telegram/callback')
        .query({ code: 'c', state: 'not-the-state' })
        .set('Cookie', second.attempt!)
        .expect(302);
      expect(bad.headers.location).toBe(`${APP}/?login_error=bad_state`);

      jest.restoreAllMocks();
      ctx.p2pBot.request.mockClear();
      const third = await startLogin();
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ id_token: 't' }), { status: 200 }),
        );
      jest
        .spyOn(ctx.app.get(AuthService), 'verifyTelegramOidcIdToken')
        .mockRejectedValue(
          Object.assign(new Error('x'), {
            response: { code: 'missing_telegram_id' },
          }),
        );
      const users = await ctx.knex('user').count<{ count: string }[]>();
      const noId = await http()
        .get('/auth/telegram/callback')
        .query({ code: 'c', state: third.url.searchParams.get('state') })
        .set('Cookie', third.attempt!)
        .expect(302);
      expect(noId.headers.location).toBe(
        `${APP}/?login_error=missing_telegram_id`,
      );
      expect(await ctx.knex('user').count<{ count: string }[]>()).toEqual(
        users,
      );
      expect(cookieFrom(noId, 'sid')).toBeUndefined();
      expect(ctx.p2pBot.request).not.toHaveBeenCalled();
    });

    it('a rate-limited start goes back to the login page, not a JSON 429', async () => {
      for (let i = 0; i < AUTH_RATE_LIMITS.start; i++) await startLogin();
      const res = await http().get('/auth/telegram/start').expect(302);
      expect(res.headers.location).toBe(`${APP}/?login_error=rate_limited`);
    });

    it("logging in again ends the browser's previous session", async () => {
      const first = await startLogin();
      mockTelegram();
      const one = await http()
        .get('/auth/telegram/callback')
        .query({ code: 'c', state: first.url.searchParams.get('state') })
        .set('Cookie', first.attempt!)
        .expect(302);
      const oldSid = cookieFrom(one, 'sid')!;
      const second = await startLogin();
      await http()
        .get('/auth/telegram/callback')
        .query({ code: 'c', state: second.url.searchParams.get('state') })
        .set('Cookie', [second.attempt!, oldSid])
        .expect(302);
      await http().get('/auth/me').set('Cookie', oldSid).expect(401);
    });

    it('never returns to another site', async () => {
      for (const evil of [
        '//evil.example',
        'https://evil.example',
        '/\\evil',
      ]) {
        const { url, attempt } = await startLogin(evil);
        mockTelegram();
        const res = await http()
          .get('/auth/telegram/callback')
          .query({ code: 'c', state: url.searchParams.get('state') })
          .set('Cookie', attempt!)
          .expect(302);
        expect(res.headers.location).toBe(`${APP}/`);
        jest.restoreAllMocks();
      }
    });
  });

  describe('guard', () => {
    const webSession = async () => {
      const { token } = await ctx.app.get(SessionService).create(USER, 'web');
      return `sid=${token}`;
    };

    beforeEach(async () => {
      await ctx
        .knex('user')
        .insert({ id: USER, first_name: 'A' })
        .onConflict('id')
        .ignore();
    });

    it('Bearer decides alone: a bad Bearer never falls back to a good cookie', async () => {
      const cookie = await webSession();
      await http().get('/auth/me').set('Cookie', cookie).expect(200);
      await http()
        .get('/auth/me')
        .set('Cookie', cookie)
        .set('Authorization', 'Bearer not-a-session')
        .expect(401);
    });

    it('cookie writes need an Origin from APP_URL; Bearer writes do not', async () => {
      const cookie = await webSession();
      await http().post('/auth/logout').set('Cookie', cookie).expect(403);
      await http()
        .post('/auth/logout')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example')
        .expect(403);
      await http()
        .post('/auth/logout')
        .set('Cookie', cookie)
        .set('Origin', APP)
        .expect(204);
      await http().get('/auth/me').set('Cookie', cookie).expect(401);

      const { token } = await miniAppLogin();
      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('logout-all revokes every device', async () => {
      const a = await miniAppLogin();
      const b = await miniAppLogin();
      const cookie = await webSession();
      const res = await http()
        .post('/auth/logout-all')
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      // two Mini App logins + the web session + resetData's fixture session
      expect(res.body.revoked).toBe(4);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${b.token}`)
        .expect(401);
      await http().get('/auth/me').set('Cookie', cookie).expect(401);
    });

    it('expired sessions are refused', async () => {
      const { token } = await miniAppLogin();
      await ctx
        .knex('user_session')
        .update({ idle_expires_at: new Date(Date.now() - 1000) });
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('legacy JWTs can read but never move sats (403 relogin_required)', async () => {
      const legacy = { Authorization: `Bearer ${ctx.legacyTokenFor(USER)}` };
      await http().get('/user/me').set(legacy).expect(200);
      const me = await http().get('/p2p/me').set(legacy).expect(403);
      expect(me.body.code).toBe('relogin_required');
      await http()
        .post('/p2p/send')
        .set(legacy)
        .send({
          to_telegram_id: 100000002,
          amount: 1000,
          idempotency_key: 'a1b2c3d4-e5f6',
        })
        .expect(403);
      expect(ctx.p2pBot.request).not.toHaveBeenCalled();
    });

    it('legacy JWTs still work; legacy logins answer 410 once LEGACY_JWT_ISSUE=false', async () => {
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${ctx.legacyTokenFor(USER)}`)
        .expect(200);
      process.env.LEGACY_JWT_ISSUE = 'false';
      await http()
        .post('/auth/telegram')
        .send({ initData: signedInitData() })
        .expect(410);
      await http()
        .post('/auth/telegram-oidc')
        .send({ id_token: 'x' })
        .expect(410);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${ctx.legacyTokenFor(USER)}`)
        .expect(200);
    });
  });
});
