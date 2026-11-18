import * as request from 'supertest';
import {
  createTestApp,
  OTHER_USER,
  resetData,
  TestContext,
  USER,
} from './support/test-app';
import { ADMIN_ORIGIN, signInAdmin } from './support/admin-session';
import {
  ACCOUNT,
  asAdmin,
  asUser,
  submitBankAccount,
} from './support/bank-account-helpers';

describe('Bank account verification (e2e)', () => {
  let ctx: TestContext;
  let cookies: string[];
  const account = (id: string) =>
    ctx.knex('user_bank_account').where({ id }).first();

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetData(ctx);
    cookies = await signInAdmin(ctx);
  });

  describe('submitting', () => {
    it('gives a temporary upload URL for the statement, under the user', async () => {
      const res = await asUser(ctx, USER)
        .post('/bank-accounts/statement-upload', {
          contentType: 'image/png',
          size: 2048,
        })
        .expect(201);
      expect(res.body.key).toMatch(
        new RegExp(`^bank-statements/${USER}/[0-9a-f-]{36}\\.png$`),
      );
      expect(res.body.method).toBe('PUT');
      expect(res.body.headers).toEqual({ 'Content-Type': 'image/png' });
      expect(ctx.storage.presignUpload).toHaveBeenCalledWith(
        res.body.key,
        'image/png',
        2048,
      );
    });

    it('rejects files that are too big or of the wrong type', async () => {
      const user = asUser(ctx, USER);
      await user
        .post('/bank-accounts/statement-upload', {
          contentType: 'application/pdf',
          size: 9 * 1024 * 1024,
        })
        .expect(400);
      await user
        .post('/bank-accounts/statement-upload', {
          contentType: 'text/html',
          size: 100,
        })
        .expect(400);
    });

    it('stores the account as PENDING_REVIEW with a name-match hint', async () => {
      const id = await submitBankAccount(ctx, USER);
      const row = await account(id);
      expect(row).toMatchObject({
        user_id: USER,
        bank_code: 7010,
        bank_name: 'Bank of Ceylon',
        account_number: '1234567890',
        account_name: 'T. User',
        status: 'PENDING_REVIEW',
      });
      // "T. User" vs profile "Test User": initial + surname
      expect(Number(row.name_match_score)).toBe(1);

      const list = await asUser(ctx, USER).get('/bank-accounts').expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          id,
          status: 'PENDING_REVIEW',
          accountNumber: '••••••7890',
        }),
      ]);
    });

    it('requires KYC', async () => {
      await asUser(ctx, OTHER_USER)
        .post('/bank-accounts/statement-upload', {
          contentType: 'application/pdf',
          size: 100,
        })
        .expect(403);
      await asUser(ctx, OTHER_USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${OTHER_USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(403);
    });

    it("refuses someone else's statement or a missing upload", async () => {
      const user = asUser(ctx, USER);
      await user
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${OTHER_USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(400);

      ctx.storage.head.mockResolvedValueOnce(null);
      await user
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(400);
    });

    it('checks the uploaded file, not what the client claimed', async () => {
      ctx.storage.head.mockResolvedValueOnce({
        size: 50 * 1024 * 1024,
        contentType: 'application/pdf',
      });
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(400);
    });

    it('rejects an unknown bank and a bad account number', async () => {
      const key = `bank-statements/${USER}/00000000-0000-4000-8000-000000000000.pdf`;
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          bankCode: 9999,
          statementKey: key,
        })
        .expect(400);
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          accountNumber: '12ab',
          statementKey: key,
        })
        .expect(400);
    });

    it('allows only one account in review or verified', async () => {
      await submitBankAccount(ctx, USER);
      const upload = await asUser(ctx, USER)
        .post('/bank-accounts/statement-upload', {
          contentType: 'application/pdf',
          size: 100,
        })
        .expect(201);
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          accountNumber: '999999999',
          statementKey: upload.body.key as string,
        })
        .expect(409);
    });
  });

  describe('admin review', () => {
    it('refuses an approve from another origin (CSRF)', async () => {
      const id = await submitBankAccount(ctx, USER);
      await request(ctx.app.getHttpServer())
        .post(`/admin/bank-reviews/${id}/approve`)
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookies)
        .expect(403);
      expect((await account(id)).status).toBe('PENDING_REVIEW');
    });

    it('needs an admin session', async () => {
      const id = await submitBankAccount(ctx, USER);
      await request(ctx.app.getHttpServer())
        .post(`/admin/bank-reviews/${id}/approve`)
        .set('Origin', ADMIN_ORIGIN)
        .expect(401);
      await request(ctx.app.getHttpServer())
        .get('/admin/bank-reviews')
        .set('Origin', ADMIN_ORIGIN)
        .expect(401);
    });

    it('lists pending accounts with the member name and match score', async () => {
      const id = await submitBankAccount(ctx, USER);
      const res = await asAdmin(ctx, cookies)
        .get('/admin/bank-reviews')
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, page: 1 });
      expect(res.body.items[0]).toMatchObject({
        id,
        userId: USER,
        memberName: 'Test User',
        accountName: 'T. User',
        accountNumber: '1234567890',
        nameMatchScore: 1,
        status: 'PENDING_REVIEW',
      });
      const count = await asAdmin(ctx, cookies)
        .get('/admin/bank-reviews/pending-count')
        .expect(200);
      expect(count.body).toEqual({ pending: 1 });
    });

    it('gives a temporary link to the statement', async () => {
      const id = await submitBankAccount(ctx, USER);
      const row = await account(id);
      const res = await asAdmin(ctx, cookies)
        .get(`/admin/bank-reviews/${id}/statement`)
        .expect(200);
      expect(ctx.storage.presignDownload).toHaveBeenCalledWith(
        row.statement_key,
      );
      expect(res.body.url).toContain(row.statement_key);
    });

    it('approving registers the account with CeyPay and verifies it', async () => {
      const id = await submitBankAccount(ctx, USER);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(200, { id, status: 'VERIFIED' });

      expect(ctx.ceyPay.upsertUser).toHaveBeenCalledWith(USER);
      expect(ctx.ceyPay.addBankAccount).toHaveBeenCalledWith(
        expect.any(String),
        {
          bankCode: 7010,
          accountNumber: '1234567890',
          accountName: 'T. User',
        },
      );
      const row = await account(id);
      expect(row.status).toBe('VERIFIED');
      expect(row.ceypay_user_bank_id).toEqual(expect.any(String));
      expect(row.reviewed_by).toBe('admin:admin@example.com');
      const user = await ctx.knex('user').where({ id: USER }).first();
      expect(user.ceypay_user_id).toEqual(expect.any(String));
      expect(ctx.notifyUser).toHaveBeenCalledWith(
        USER,
        expect.stringContaining('verified'),
      );

      // a second approve is a conflict, not a second CeyPay registration
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(409);
      expect(ctx.ceyPay.addBankAccount).toHaveBeenCalledTimes(1);
    });

    it('keeps the account pending when CeyPay fails', async () => {
      const id = await submitBankAccount(ctx, USER);
      ctx.ceyPay.addBankAccount.mockRejectedValueOnce(new Error('CeyPay down'));
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(502);
      expect((await account(id)).status).toBe('PENDING_REVIEW');
    });

    it('rejecting needs a reason and lets the user resubmit', async () => {
      const id = await submitBankAccount(ctx, USER);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/reject`, { reason: '  ' })
        .expect(400);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/reject`, {
          reason: 'Name does not match',
        })
        .expect(200, { id, status: 'REJECTED' });

      const row = await account(id);
      expect(row.rejection_reason).toBe('Name does not match');
      expect(ctx.ceyPay.addBankAccount).not.toHaveBeenCalled();
      expect(ctx.notifyUser).toHaveBeenCalledWith(
        USER,
        expect.stringContaining('Name does not match'),
      );

      // the same account can be submitted again
      const again = await submitBankAccount(ctx, USER);
      expect(again).not.toBe(id);
      expect((await account(id)).is_active).toBe(false);
    });
  });

  describe('removing', () => {
    it('soft-deletes the account', async () => {
      const id = await submitBankAccount(ctx, USER);
      await asUser(ctx, USER).delete(`/bank-accounts/${id}`).expect(204);
      expect((await account(id)).is_active).toBe(false);
      await asUser(ctx, USER).get('/bank-accounts').expect(200, []);
    });

    it("can't remove another user's account", async () => {
      const id = await submitBankAccount(ctx, USER);
      await asUser(ctx, OTHER_USER).delete(`/bank-accounts/${id}`).expect(404);
    });
  });
});
