import * as request from 'supertest';
import type { App } from 'supertest/types';
import { ADMIN_AUTH_BASE_PATH } from '../src/modules/admin/auth/admin-auth.constants';
import { createTestApp, resetData, TestContext } from './support/test-app';
import { ADMIN_ORIGIN, signInAdmin } from './support/admin-session';

interface AdminView {
  id: string;
  name: string;
  email: string;
  banned: boolean;
}

describe('Admin admins (e2e)', () => {
  let ctx: TestContext;
  let cookies: string[];
  const server = () => ctx.app.getHttpServer() as App;
  const create = (body: object, origin = ADMIN_ORIGIN) =>
    request(server())
      .post('/admin/admins')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .send(body);
  const valid = {
    email: ' New.Admin@Example.com ',
    name: ' New Admin ',
    password: 'another-long-password',
  };

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetData(ctx);
    cookies = await signInAdmin(ctx);
  });

  it('creates an admin who can then sign in', async () => {
    const res = await create(valid).expect(201);
    const body = res.body as AdminView;
    expect(body).toMatchObject({
      email: 'new.admin@example.com',
      name: 'New Admin',
      banned: false,
    });

    const list = await request(server())
      .get('/admin/admins')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', cookies)
      .expect(200);
    expect((list.body as AdminView[]).map((a) => a.email)).toEqual([
      'admin@example.com',
      'new.admin@example.com',
    ]);

    await request(server())
      .post(`${ADMIN_AUTH_BASE_PATH}/sign-in/email`)
      .set('Origin', ADMIN_ORIGIN)
      .send({ email: 'new.admin@example.com', password: valid.password })
      .expect(200);
  });

  it('refuses a duplicate email', async () => {
    await create({ ...valid, email: 'ADMIN@example.com' }).expect(409);
  });

  it('refuses a short password and a bad email', async () => {
    await create({ ...valid, password: 'short' }).expect(400);
    await create({ ...valid, email: 'not-an-email' }).expect(400);
  });

  it('needs an admin session and the dashboard origin', async () => {
    await request(server())
      .post('/admin/admins')
      .set('Origin', ADMIN_ORIGIN)
      .send(valid)
      .expect(401);
    await request(server()).get('/admin/admins').expect(401);
    await create(valid, 'https://evil.example').expect(403);
  });
});
