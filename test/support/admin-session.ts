import * as request from 'supertest';
import type { AdminAuth } from '../../src/modules/admin/auth/admin-auth.config';
import {
  ADMIN_AUTH,
  ADMIN_AUTH_BASE_PATH,
} from '../../src/modules/admin/auth/admin-auth.constants';
import type { TestContext } from './test-app';

export const ADMIN_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';

/** Create an admin and sign in; returns the session cookies. */
export async function signInAdmin(ctx: TestContext): Promise<string[]> {
  await ctx.app.get<AdminAuth>(ADMIN_AUTH).api.createUser({
    body: {
      email: 'admin@example.com',
      password: PASSWORD,
      name: 'Admin',
      role: 'admin',
    },
  });
  const res = await request(ctx.app.getHttpServer())
    .post(`${ADMIN_AUTH_BASE_PATH}/sign-in/email`)
    .set('Origin', ADMIN_ORIGIN)
    .send({ email: 'admin@example.com', password: PASSWORD })
    .expect(200);
  return res.headers['set-cookie'] as unknown as string[];
}
