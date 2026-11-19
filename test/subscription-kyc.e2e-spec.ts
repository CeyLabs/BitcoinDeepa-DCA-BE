import * as request from 'supertest';
import { createHash, createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  createTestApp,
  resetData,
  payhereNotification,
  diditWebhook,
  sats,
  TestContext,
  USER,
  OTHER_USER,
  PACKAGE_WEEKLY,
} from './support/test-app';

describe('Auth, KYC, subscriptions and read endpoints (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const auth = (userId = USER) => ({
    Authorization: `Bearer ${ctx.tokenFor(userId)}`,
  });

  async function subscribe(userId = USER, subscription_id = 'S1') {
    const res = await http()
      .post('/subscription/payhere-link')
      .set(auth(userId))
      .send({ package_id: PACKAGE_WEEKLY })
      .expect(201);
    const order_id = new URL(res.body.link as string).searchParams.get(
      'order_id',
    )!;
    await http()
      .post('/transaction/payhere-webhook')
      .type('form')
      .send(
        payhereNotification({
          order_id,
          payment_id: `P-${subscription_id}`,
          subscription_id,
        }),
      )
      .expect(200);
    return order_id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(() => resetData(ctx));

  describe('authentication', () => {
    it('protected endpoints need a valid JWT', async () => {
      await http().get('/user/me').expect(401);
      await http()
        .get('/user/me')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
      await http().get('/user/me').set(auth()).expect(200);
    });

    it('POST /auth/telegram exchanges valid initData for a JWT and registers the user', async () => {
      const fields = {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({
          id: 555,
          first_name: 'New',
          username: 'newbie',
        }),
      };
      const dcs = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join('\n');
      const secret = createHmac('sha256', 'WebAppData')
        .update(process.env.TELEGRAM_BOT_TOKEN!)
        .digest();
      const hash = createHmac('sha256', secret).update(dcs).digest('hex');
      const initData = new URLSearchParams({ ...fields, hash }).toString();

      const res = await http()
        .post('/auth/telegram')
        .send({ initData })
        .expect(201);
      expect(res.body).toMatchObject({
        user: { telegram_id: '555' },
        isRegistered: false,
      });
      await http()
        .get('/user/me')
        .set('Authorization', `Bearer ${res.body.token}`)
        .expect(200);

      await http()
        .post('/auth/telegram')
        .send({ initData: initData.replace('New', 'Evil') })
        .expect(401);
      await http().post('/auth/telegram').send({}).expect(400);
    });

    it('POST /auth/telegram-oidc exchanges a verified id_token for a JWT', async () => {
      // Token verification itself is covered in telegram-oidc.spec.ts
      const verify = jest.spyOn(
        ctx.app.get(AuthService),
        'verifyTelegramOidcToken',
      );
      const original = process.env.TELEGRAM_OIDC_CLIENT_ID;
      try {
        delete process.env.TELEGRAM_OIDC_CLIENT_ID;
        await http()
          .post('/auth/telegram-oidc')
          .send({ id_token: 'x' })
          .expect(401);

        process.env.TELEGRAM_OIDC_CLIENT_ID = 'client-1';
        await http().post('/auth/telegram-oidc').send({}).expect(400);

        verify.mockRejectedValueOnce(new UnauthorizedException());
        await http()
          .post('/auth/telegram-oidc')
          .send({ id_token: 'forged' })
          .expect(401);

        verify.mockResolvedValue({
          id: '777',
          given_name: 'Web',
          preferred_username: 'webuser',
        });
        const res = await http()
          .post('/auth/telegram-oidc')
          .send({ id_token: 'good' })
          .expect(201);
        expect(verify).toHaveBeenLastCalledWith('good', 'client-1');
        expect(res.body).toMatchObject({
          user: { telegram_id: '777', username: 'webuser' },
          isRegistered: false,
        });
        expect(
          await ctx.knex('user').where({ id: '777' }).first(),
        ).toMatchObject({ first_name: 'Web' });
        await http()
          .get('/user/me')
          .set('Authorization', `Bearer ${res.body.token}`)
          .expect(200);

        // second login: same user, now registered
        const again = await http()
          .post('/auth/telegram-oidc')
          .send({ id_token: 'good' })
          .expect(201);
        expect(again.body.isRegistered).toBe(true);
      } finally {
        verify.mockRestore();
        process.env.TELEGRAM_OIDC_CLIENT_ID = original;
        if (original === undefined) delete process.env.TELEGRAM_OIDC_CLIENT_ID;
      }
    });

    it('admin endpoint needs x-admin-key', async () => {
      const url = '/transaction/reset-retry-count/P-none';
      await http().post(url).expect(403);
      await http().post(url).set('x-admin-key', 'wrong').expect(403);
      // past the guard: unknown payment
      await http().post(url).set('x-admin-key', 'test-admin-key').expect(404);
    });
  });

  describe('KYC', () => {
    it('payment link is blocked until KYC is approved via a signed Didit webhook', async () => {
      await http()
        .post('/subscription/payhere-link')
        .set(auth(OTHER_USER))
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(403);

      ctx.didit.createVerificationSession.mockResolvedValue({
        session_id: 'sess-1',
        url: 'https://verify.test/s',
        status: 'Not Started',
      });
      const init = await http()
        .post('/user/kyc/initiate')
        .set(auth(OTHER_USER))
        .expect(201);
      expect(init.body).toEqual({
        session_id: 'sess-1',
        url: 'https://verify.test/s',
      });

      // unsigned webhook is refused
      await http()
        .post('/didit/webhook')
        .send({ session_id: 'sess-1', status: 'Approved' })
        .expect(401);

      const { raw, headers } = diditWebhook({
        session_id: 'sess-1',
        status: 'Approved',
        webhook_type: 'status.updated',
      });
      await http().post('/didit/webhook').set(headers).send(raw).expect(201);

      const status = await http()
        .get('/user/kyc/status')
        .set(auth(OTHER_USER))
        .expect(200);
      expect(status.body.status).toBe('APPROVED');
      await http()
        .post('/subscription/payhere-link')
        .set(auth(OTHER_USER))
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(201);
    });

    it('applies each Didit event once and refuses stale ones', async () => {
      await ctx
        .knex('user')
        .where({ id: OTHER_USER })
        .update({ kyc_status: 'IN_PROGRESS', kyc_session_id: 'sess-r' });
      const now = Math.floor(Date.now() / 1000);
      const declined = diditWebhook({
        event_id: 'evt-1',
        timestamp: now,
        session_id: 'sess-r',
        status: 'Declined',
      });
      await http()
        .post('/didit/webhook')
        .set(declined.headers)
        .send(declined.raw)
        .expect(201);
      await ctx
        .knex('user')
        .where({ id: OTHER_USER })
        .update({ kyc_status: 'APPROVED' });

      // the same event again (a replay, or a retry) changes nothing
      const again = diditWebhook({
        event_id: 'evt-1',
        timestamp: now,
        session_id: 'sess-r',
        status: 'Declined',
      });
      await http()
        .post('/didit/webhook')
        .set(again.headers)
        .send(again.raw)
        .expect(201);
      const row = await ctx.knex('user').where({ id: OTHER_USER }).first();
      expect(row.kyc_status).toBe('APPROVED');

      // a signed body from two days ago is refused, whatever X-Timestamp says
      const stale = diditWebhook({
        event_id: 'evt-2',
        timestamp: now - 2 * 24 * 3600,
        session_id: 'sess-r',
        status: 'Declined',
      });
      await http()
        .post('/didit/webhook')
        .set(stale.headers)
        .send(stale.raw)
        .expect(401);
    });

    it('resumes an open Didit session instead of creating a new one', async () => {
      await ctx
        .knex('user')
        .where({ id: OTHER_USER })
        .update({ kyc_status: 'IN_PROGRESS', kyc_session_id: 'sess-open' });
      ctx.didit.getSession.mockResolvedValue({
        status: 'In Progress',
        url: 'https://verify.test/open',
      });
      const res = await http()
        .post('/user/kyc/initiate')
        .set(auth(OTHER_USER))
        .expect(201);
      expect(res.body).toEqual({
        session_id: 'sess-open',
        url: 'https://verify.test/open',
      });
      expect(ctx.didit.createVerificationSession).not.toHaveBeenCalled();
    });

    it.each([
      ['Approved', 'APPROVED'],
      ['In Review', 'IN_REVIEW'],
    ])(
      'restarting KYC records a missed "%s" result instead of replacing the session',
      async (diditStatus, stored) => {
        await ctx
          .knex('user')
          .where({ id: OTHER_USER })
          .update({ kyc_status: 'IN_PROGRESS', kyc_session_id: 'sess-done' });
        ctx.didit.getSession.mockResolvedValueOnce({
          status: diditStatus,
          url: 'https://verify.test/done',
        });

        await http()
          .post('/user/kyc/initiate')
          .set(auth(OTHER_USER))
          .expect(400);
        expect(ctx.didit.createVerificationSession).not.toHaveBeenCalled();
        expect(
          await ctx.knex('user').where({ id: OTHER_USER }).first(),
        ).toMatchObject({ kyc_status: stored, kyc_session_id: 'sess-done' });
      },
    );

    it('restarting after a Declined session starts a new one', async () => {
      await ctx
        .knex('user')
        .where({ id: OTHER_USER })
        .update({ kyc_status: 'IN_PROGRESS', kyc_session_id: 'sess-old' });
      ctx.didit.getSession.mockResolvedValueOnce({
        status: 'Declined',
        url: null,
      });
      ctx.didit.createVerificationSession.mockResolvedValueOnce({
        session_id: 'sess-new',
        url: 'https://verify.test/new',
      });
      await http().post('/user/kyc/initiate').set(auth(OTHER_USER)).expect(201);
      expect(
        await ctx.knex('user').where({ id: OTHER_USER }).first(),
      ).toMatchObject({ kyc_session_id: 'sess-new' });
    });

    it('cannot start KYC again once approved', async () => {
      await http().post('/user/kyc/initiate').set(auth(USER)).expect(400);
    });
  });

  describe('subscriptions', () => {
    it('validates the package id', async () => {
      await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: 'nope' })
        .expect(400);
      await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({})
        .expect(400);
      await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: '00000000-0000-0000-0000-000000000099' })
        .expect(404);
    });

    it('the payment link carries a correct PayHere checkout hash', async () => {
      const res = await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(201);
      const p = new URL(res.body.link as string).searchParams;
      const md5U = (s: string) =>
        createHash('md5').update(s).digest('hex').toUpperCase();
      expect(p.get('amount')).toBe('1000.00');
      expect(p.get('recurrence')).toBe('1 Week');
      expect(p.get('hash')).toBe(
        md5U(
          `${p.get('merchant_id')}${p.get('order_id')}1000.00LKR${md5U(process.env.PAYHERE_MERCHANT_SECRET!)}`,
        ),
      );
      expect(
        await ctx
          .knex('payhere_order')
          .where({ order_id: p.get('order_id')! })
          .first(),
      ).toMatchObject({ user_id: USER });
    });

    it('requires a complete profile', async () => {
      await ctx.knex('user').where({ id: USER }).update({ email: null });
      await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(400);
    });

    it('one active plan at a time; current + cancel work', async () => {
      await http().get('/subscription/current').set(auth()).expect(404);
      await subscribe();
      await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(409);

      const current = await http()
        .get('/subscription/current')
        .set(auth())
        .expect(200);
      expect(current.body).toMatchObject({
        payhere_sub_id: 'S1',
        is_active: true,
        payment_processor: 'PAYHERE',
        frequency: 'weekly',
      });

      await http().post('/subscription/cancel').set(auth()).expect(201);
      expect(ctx.payHereCancel).toHaveBeenCalledWith('S1');
      await http().get('/subscription/current').set(auth()).expect(404);
    });

    it('cancel fails cleanly when PayHere refuses', async () => {
      await subscribe();
      ctx.payHereCancel.mockResolvedValueOnce({
        status: -1,
        msg: 'Subscription is already cancelled.',
      });
      await http().post('/subscription/cancel').set(auth()).expect(400);
      expect(
        await ctx.knex('subscription').where({ payhere_sub_id: 'S1' }).first(),
      ).toMatchObject({ is_active: true });
    });
  });

  describe('read endpoints', () => {
    it('list, latest and DCA summary reflect payments (caches invalidated)', async () => {
      // prime caches with the empty state
      await http().get('/transaction/dca-summary').set(auth()).expect(200);
      await http().get('/transaction/list').set(auth()).expect(200);

      const order_id = await subscribe();
      await http()
        .post('/transaction/payhere-webhook')
        .type('form')
        .send(
          payhereNotification({
            order_id,
            payment_id: 'P-2',
            subscription_id: 'S1',
          }),
        )
        .expect(200);

      const list = await http()
        .get('/transaction/list?limit=10')
        .set(auth())
        .expect(200);
      expect(list.body.total_count).toBe(2);
      expect(list.body.transactions[0]).toMatchObject({
        package_name: 'Shrimp Weekly',
      });

      const latest = await http()
        .get('/transaction/latest')
        .set(auth())
        .expect(200);
      expect(latest.body.payhere_pay_id).toBe('P-2');

      const summary = await http()
        .get('/transaction/dca-summary')
        .set(auth())
        .expect(200);
      expect(summary.body.dca).toEqual({
        balance: 2 * sats(980),
        spent: 1960,
        fees: 40,
        avg_btc_price: expect.any(Number),
      });
      expect(summary.body.current_btc_price).toEqual({
        usd: 65000,
        lkr: 21_450_000,
      });
    });

    it('clamps bad pagination instead of erroring', async () => {
      const res = await http()
        .get('/transaction/list?page=0&limit=abc')
        .set(auth())
        .expect(200);
      expect(res.body).toMatchObject({ current_page: 1 });
      await http().get('/transaction/list?limit=-5').set(auth()).expect(200);
    });

    it('latest returns 404 without an active plan', async () => {
      await http().get('/transaction/latest').set(auth()).expect(404);
    });

    it('health reports database and redis up', async () => {
      // Overall status also depends on heap/RSS limits (150 MB), which the
      // test runner itself exceeds - only assert the dependencies here.
      const res = await http().get('/health');
      expect(res.body.details).toMatchObject({
        database: { status: 'up' },
        redis: { status: 'up' },
      });
    });
  });
});
