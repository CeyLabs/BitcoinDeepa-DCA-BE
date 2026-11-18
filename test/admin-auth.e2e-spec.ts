import * as request from 'supertest';
import type { AdminAuth } from '../src/modules/admin/auth/admin-auth.config';
import {
  ADMIN_AUTH,
  ADMIN_AUTH_BASE_PATH,
} from '../src/modules/admin/auth/admin-auth.constants';
import { createTestApp, resetData, TestContext } from './support/test-app';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';

describe('Admin dashboard auth (e2e)', () => {
  let ctx: TestContext;
  let auth: AdminAuth;
  const http = () => request(ctx.app.getHttpServer());

  const signIn = (email: string, password = PASSWORD) =>
    http()
      .post(`${ADMIN_AUTH_BASE_PATH}/sign-in/email`)
      .set('Origin', ORIGIN)
      .send({ email, password });

  async function createUser(email: string, role: 'admin' | 'user') {
    await auth.api.createUser({
      body: { email, password: PASSWORD, name: 'Test', role },
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    auth = ctx.app.get<AdminAuth>(ADMIN_AUTH);
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetData(ctx));

  it('signs an admin in and lets them call admin endpoints', async () => {
    await createUser('admin@example.com', 'admin');

    const res = await signIn('admin@example.com').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toContain('bd-admin.session_token');

    const me = await http()
      .get('/admin/me')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .expect(200);
    expect(me.body).toMatchObject({
      email: 'admin@example.com',
      role: 'admin',
    });
  });

  it('answers the browser preflight for the dashboard origin', async () => {
    const res = await http()
      .options(`${ADMIN_AUTH_BASE_PATH}/sign-in/email`)
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses to sign in a non-admin', async () => {
    await createUser('staff@example.com', 'user');
    await signIn('staff@example.com').expect(403);
    const sessions = await ctx.knex('admin_session').count('* as n').first();
    expect(Number(sessions?.n)).toBe(0);
  });

  it('rejects a wrong password', async () => {
    await createUser('admin@example.com', 'admin');
    await signIn('admin@example.com', 'wrong-password-123').expect(401);
  });

  it('does not allow public sign-up', async () => {
    await http()
      .post(`${ADMIN_AUTH_BASE_PATH}/sign-up/email`)
      .set('Origin', ORIGIN)
      .send({ email: 'new@example.com', password: PASSWORD, name: 'New' })
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    expect(await ctx.knex('admin_user').count('* as n').first()).toEqual({
      n: '0',
    });
  });

  it('protects admin endpoints', async () => {
    await http().get('/admin/me').expect(401);
  });

  it('keeps the non-admin CORS policy for other origins', async () => {
    const res = await http()
      .get('/package')
      .set('Origin', 'https://t.me')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // never credentialed: only the dashboard's origins may read with cookies
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
