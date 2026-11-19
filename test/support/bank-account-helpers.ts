import * as request from 'supertest';
import type { TestContext } from './test-app';
import { ADMIN_ORIGIN } from './admin-session';

export const ACCOUNT = {
  bankCode: 7010,
  accountNumber: '1234-5678 90',
  accountName: 'T. User',
};

export const asUser = (ctx: TestContext, userId: string) => {
  const server = ctx.app.getHttpServer();
  const auth = `Bearer ${ctx.tokenFor(userId)}`;
  return {
    get: (path: string) => request(server).get(path).set('Authorization', auth),
    post: (path: string, body?: object) =>
      request(server)
        .post(path)
        .set('Authorization', auth)
        .send(body ?? {}),
    delete: (path: string) =>
      request(server).delete(path).set('Authorization', auth),
  };
};

export const asAdmin = (ctx: TestContext, cookies: string[]) => {
  const server = ctx.app.getHttpServer();
  return {
    get: (path: string) =>
      request(server)
        .get(path)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', cookies),
    post: (path: string, body?: object) =>
      request(server)
        .post(path)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', cookies)
        .send(body ?? {}),
  };
};

/** Upload a statement and submit the account; returns the account id. */
export async function submitBankAccount(
  ctx: TestContext,
  userId: string,
  account: Partial<typeof ACCOUNT> = {},
): Promise<string> {
  const user = asUser(ctx, userId);
  const upload = await user
    .post('/bank-accounts/statement-upload', {
      contentType: 'application/pdf',
      size: 120_000,
    })
    .expect(201);
  const res = await user
    .post('/bank-accounts', {
      ...ACCOUNT,
      ...account,
      statementKey: upload.body.key as string,
    })
    .expect(201);
  return res.body.id as string;
}

/** Submit + admin approve. */
export async function verifiedBankAccount(
  ctx: TestContext,
  userId: string,
  adminCookies: string[],
): Promise<string> {
  const id = await submitBankAccount(ctx, userId);
  await asAdmin(ctx, adminCookies)
    .post(`/admin/bank-reviews/${id}/approve`)
    .expect(200);
  return id;
}
