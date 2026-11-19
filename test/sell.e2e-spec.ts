import * as request from 'supertest';
import { randomUUID } from 'crypto';
import {
  ceypayWebhook,
  collectOk,
  createTestApp,
  CEYPAY_USDT_LKR,
  resetData,
  TestContext,
  USER,
} from './support/test-app';
import { signInAdmin } from './support/admin-session';
import {
  asUser,
  submitBankAccount,
  verifiedBankAccount,
} from './support/bank-account-helpers';
import { SellSettlementService } from '../src/modules/sell/sell-settlement.service';
import { SellService } from '../src/modules/sell/sell.service';
import { CeyPayError } from '../src/modules/ceypay/ceypay.service';
import { TelegramLoggerService } from '../src/modules/telegram-logger/telegram-logger.service';
import { RedisService } from '../src/modules/redis/redis.service';
import { CacheKeys } from '../src/modules/redis/utils/cache-keys.util';

// 100,000 sats, 1% fee = 1,000 sats; 99,000 sats at 20,000,000 LKR/BTC
const SATS = 100_000;
// 100,000 sats × (65,000 USD × 330 LKR/USDT) = 21,450 LKR, minus the 1% fee
const AMOUNT_LKR = 21_235.5;

describe('Sell flow (e2e)', () => {
  let ctx: TestContext;
  let cookies: string[];
  let settlement: SellSettlementService;
  let logAlert: jest.SpyInstance;
  const order = (id: string) => ctx.knex('sell_order').where({ id }).first();

  const quote = async (sats = SATS) =>
    (await asUser(ctx, USER).post('/sell/quote', { sats }).expect(201))
      .body as { id: string; amountLkr: number };

  const webhook = (body: Record<string, unknown>, timestamp?: number) => {
    const { raw, headers } = ceypayWebhook(body, timestamp);
    return request(ctx.app.getHttpServer())
      .post('/sell/ceypay-webhook')
      .set(headers)
      .send(raw);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    settlement = ctx.app.get(SellSettlementService);
    logAlert = jest
      .spyOn(ctx.app.get(TelegramLoggerService), 'logAlert')
      .mockResolvedValue();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetData(ctx);
    cookies = await signInAdmin(ctx);
    ctx.bitcoinDeepa.getUserBalance.mockResolvedValue({
      success: true,
      balance: 1_000_000,
    });
  });

  describe('switched off (SELL_ENABLED)', () => {
    afterEach(() => {
      process.env.SELL_ENABLED = 'true';
    });

    it('answers 503 to new sales and bank accounts, but still shows orders', async () => {
      process.env.SELL_ENABLED = 'false';
      await asUser(ctx, USER).get('/sell/price').expect(503);
      await asUser(ctx, USER).post('/sell/quote', { sats: SATS }).expect(503);
      await asUser(ctx, USER).get('/bank-accounts/banks').expect(503);
      await asUser(ctx, USER).get('/sell/orders').expect(200);
      await asUser(ctx, USER).get('/bank-accounts').expect(200);
    });
  });

  describe('who can sell', () => {
    it('blocks a user without a bank account', async () => {
      const res = await asUser(ctx, USER)
        .post('/sell/quote', { sats: SATS })
        .expect(403);
      expect(res.body.message).toMatch(/Add a bank account/);
    });

    it('blocks a user whose account is still in review', async () => {
      await submitBankAccount(ctx, USER);
      const res = await asUser(ctx, USER)
        .post('/sell/quote', { sats: SATS })
        .expect(403);
      expect(res.body.message).toMatch(/still being reviewed/);
    });

    it('blocks a user whose account was rejected', async () => {
      const id = await submitBankAccount(ctx, USER);
      await request(ctx.app.getHttpServer())
        .post(`/admin/bank-reviews/${id}/reject`)
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', cookies)
        .send({ reason: 'No match' })
        .expect(200);
      await asUser(ctx, USER).post('/sell/quote', { sats: SATS }).expect(403);
    });

    it('blocks a user whose KYC is no longer approved', async () => {
      await verifiedBankAccount(ctx, USER, cookies);
      await ctx
        .knex('user')
        .where({ id: USER })
        .update({ kyc_status: 'EXPIRED' });
      await asUser(ctx, USER).post('/sell/quote', { sats: SATS }).expect(403);
    });
  });

  describe('with a verified bank account', () => {
    let bankId: string;
    beforeEach(async () => {
      bankId = await verifiedBankAccount(ctx, USER, cookies);
    });

    it('gives the live price with the fee and the minimum sale', async () => {
      const res = await asUser(ctx, USER).get('/sell/price').expect(200);
      expect(res.body).toEqual({
        btcLkrRate: 21_450_000,
        feeBasisPoints: 100,
        minSats: 1000,
        maxSats: 5_000_000,
      });
    });

    it('prices at Ceylon Cash BTC/USD × CeyPay USDT/LKR, fee taken in LKR', async () => {
      const res = await asUser(ctx, USER)
        .post('/sell/quote', { sats: SATS })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'QUOTED',
        sats: SATS,
        feeBasisPoints: 100,
        grossLkr: 21_450,
        feeLkr: 214.5,
        btcLkrRate: 21_450_000,
        amountLkr: AMOUNT_LKR,
      });
      // Only CeyPay's rate is read: no USDT quote is locked until the user confirms
      for (const [usdt] of ctx.ceyPay.getQuote.mock.calls)
        expect(usdt).toBe('1');
      expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();
    });

    it('refuses more than the balance, and dust', async () => {
      ctx.bitcoinDeepa.getUserBalance.mockResolvedValue({
        success: true,
        balance: 50_000,
      });
      await asUser(ctx, USER).post('/sell/quote', { sats: SATS }).expect(400);
      await asUser(ctx, USER).post('/sell/quote', { sats: 10 }).expect(400);
    });

    it('happy path: collect sats, CeyPay payout, webhook completes it', async () => {
      const q = await quote();
      const confirmed = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(200);
      expect(confirmed.body.status).toBe('PAYOUT_PENDING');

      // The order id is the request's external_id: asking again is idempotent
      expect(ctx.bitcoinDeepa.createCollect).toHaveBeenCalledWith(
        USER,
        SATS,
        'Bitcoin Deepa sale: 21,235.50 LKR to your bank account',
        q.id,
      );
      // USDT sized from CeyPay's rate so it pays at least our LKR
      const [usdt] = ctx.ceyPay.getQuote.mock.calls.at(-1) as [string];
      expect(
        Math.round(Number(usdt) * CEYPAY_USDT_LKR * 100),
      ).toBeGreaterThanOrEqual(AMOUNT_LKR * 100);
      const bank = await ctx
        .knex('user_bank_account')
        .where({ id: bankId })
        .first();
      const user = await ctx.knex('user').where({ id: USER }).first();
      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.ceypay_user_id,
          userBankId: bank.ceypay_user_bank_id,
          externalRef: q.id,
          webhookUrl: 'https://example.test/sell/ceypay-webhook',
        }),
      );

      const row = await order(q.id);
      await webhook({
        event: 'payment.completed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
        amountLkr: AMOUNT_LKR,
        bankRef: 'BOC-123',
        completedAt: new Date().toISOString(),
      }).expect(200);

      expect(await order(q.id)).toMatchObject({
        status: 'COMPLETED',
        bank_ref: 'BOC-123',
      });
      expect(ctx.notifyUser).toHaveBeenCalledWith(
        USER,
        expect.stringContaining('21235.50 LKR'),
      );

      // a late failure webhook can't undo it
      await webhook({
        event: 'payment.failed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
        failureReason: 'late',
      }).expect(200);
      expect((await order(q.id)).status).toBe('COMPLETED');
      expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
    });

    it("the member's history (/transaction/list) shows sales next to purchases", async () => {
      const list = async (query = '') =>
        (await asUser(ctx, USER).get(`/transaction/list${query}`).expect(200))
          .body as {
          total_count: number;
          has_more: boolean;
          transactions: Record<string, unknown>[];
        };
      // An older purchase (recurring rows need no order)
      await ctx.knex('transaction').insert({
        payhere_pay_id: 'P-OLD',
        user_id: USER,
        status: 'SUCCESS',
        created_at: ctx.knex.raw("now() - interval '1 hour'"),
      });

      // A quote is not a sale yet (this also caches the list)
      const q = await quote();
      expect((await list()).total_count).toBe(1);

      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const page = await list();
      expect(page.total_count).toBe(2);
      expect(page.transactions.map((t) => t.type)).toEqual(['SELL', 'BUY']);
      expect(page.transactions[0]).toEqual({
        type: 'SELL',
        created_at: expect.any(String),
        sell_order: expect.objectContaining({
          id: q.id,
          status: 'PAYOUT_PENDING',
          sats: SATS,
          amountLkr: AMOUNT_LKR,
        }),
      });
      expect(page.transactions[1]).toMatchObject({
        type: 'BUY',
        payhere_pay_id: 'P-OLD',
      });

      // Pages are cut across both tables
      const first = await list('?limit=1');
      expect(first).toMatchObject({ total_count: 2, has_more: true });
      expect(first.transactions[0].type).toBe('SELL');
      const second = await list('?limit=1&page=2');
      expect(second.transactions[0].payhere_pay_id).toBe('P-OLD');

      // The cached list follows the sale
      const row = await order(q.id);
      await webhook({
        event: 'payment.completed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
        amountLkr: AMOUNT_LKR,
        bankRef: 'BOC-123',
        completedAt: new Date().toISOString(),
      }).expect(200);
      expect((await list()).transactions[0].sell_order).toMatchObject({
        status: 'COMPLETED',
        bankRef: 'BOC-123',
      });

      // A sale that never happened is left out
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ status: 'EXPIRED' });
      await ctx.app
        .get(RedisService)
        .delByPattern(CacheKeys.patterns.userTransactionLists(USER));
      expect((await list()).total_count).toBe(1);
    });

    it('commits COLLECTING before asking the bot, so a crash leaves a trace', async () => {
      const q = await quote();
      let statusDuringDebit: string | undefined;
      ctx.bitcoinDeepa.createCollect.mockImplementationOnce(async () => {
        // read from another connection: the status is already committed
        statusDuringDebit = (await order(q.id)).status;
        return collectOk({ paid: true });
      });
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      expect(statusDuringDebit).toBe('COLLECTING');
    });

    it('hands an order stuck in COLLECTING or REFUNDING to a human', async () => {
      const a = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: a.id })
        .update({
          status: 'COLLECTING',
          updated_at: ctx.knex.raw("now() - interval '3 minutes'"),
        });
      await settlement.recoverStuckOrders();
      expect(await order(a.id)).toMatchObject({ status: 'NEEDS_REVIEW' });
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining(`memo sell:${a.id}`),
      );

      // a fresh one is left alone
      const b = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: b.id })
        .update({ status: 'REFUNDING' });
      await settlement.recoverStuckOrders();
      expect((await order(b.id)).status).toBe('REFUNDING');

      // a collect request nobody finished 30 min after its window
      const c = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: c.id })
        .update({
          status: 'COLLECTING',
          bot_collect_id: 'col-stuck',
          collect_expires_at: ctx.knex.raw("now() - interval '31 minutes'"),
        });
      await settlement.recoverStuckOrders();
      expect((await order(c.id)).status).toBe('NEEDS_REVIEW');
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining('collect request col-stuck'),
      );
    });

    it('enforces the per-sale and the daily limits', async () => {
      await asUser(ctx, USER)
        .post('/sell/quote', { sats: 5_000_001 })
        .expect(400);

      // 19.95M already sold today: only 50k left
      const q = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ status: 'COMPLETED', sats: '19950000' });
      const res = await asUser(ctx, USER)
        .post('/sell/quote', { sats: SATS })
        .expect(400);
      expect(res.body.message).toBe(
        'You can sell up to 50,000 more sats today',
      );
    });

    it('checks the daily limit again at confirm', async () => {
      const q = await quote();
      // another sale finished between the quote and the confirm
      const other = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: other.id })
        .update({ status: 'COMPLETED', sats: '19950000' });
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({
          status: 'QUOTED',
          expires_at: new Date(Date.now() + 60_000),
        });
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(400);
      expect(ctx.bitcoinDeepa.createCollect).not.toHaveBeenCalled();
      expect((await order(q.id)).status).toBe('QUOTED');
    });

    it('confirming twice collects once', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const again = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(200);
      expect(again.body.status).toBe('PAYOUT_PENDING');
      expect(ctx.bitcoinDeepa.createCollect).toHaveBeenCalledTimes(1);
      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(1);
    });

    it("can't confirm someone else's order", async () => {
      const q = await quote();
      await asUser(ctx, '100000002')
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(403); // OTHER_USER has no KYC
      expect(ctx.bitcoinDeepa.createCollect).not.toHaveBeenCalled();
    });

    it('an expired quote moves nothing', async () => {
      const q = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ expires_at: new Date(Date.now() - 1000) });
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(410);
      expect((await order(q.id)).status).toBe('EXPIRED');
      expect(ctx.bitcoinDeepa.createCollect).not.toHaveBeenCalled();
    });

    it('a new quote replaces the previous one', async () => {
      const first = await quote();
      await quote();
      expect((await order(first.id)).status).toBe('EXPIRED');
    });

    it('a refused collect request (e.g. amount too large) cancels the sale', async () => {
      ctx.bitcoinDeepa.createCollect.mockResolvedValueOnce({
        kind: 'refused',
        status: 400,
        code: 'amount_too_large',
        message: 'Amount is above the limit.',
      });
      const q = await quote();
      const res = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(400);
      expect(res.body.message).toBe('Amount is above the limit.');
      expect((await order(q.id)).status).toBe('EXPIRED');
      expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();
    });

    it('a wallet without can_collect alerts and answers 503', async () => {
      ctx.bitcoinDeepa.createCollect.mockResolvedValueOnce({
        kind: 'refused',
        status: 403,
        code: 'collect_not_allowed',
        message: 'This wallet is not allowed to collect.',
      });
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(503);
      expect((await order(q.id)).status).toBe('EXPIRED');
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining('can_collect'),
      );
    });

    it('no answer from the bot: the sync asks again with the same external_id', async () => {
      ctx.bitcoinDeepa.createCollect.mockResolvedValueOnce({
        kind: 'unknown',
        message: 'timeout',
      });
      const q = await quote();
      const res = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'COLLECTING',
        collect: { state: 'requesting' },
      });

      await settlement.syncCollects();
      expect((await order(q.id)).status).toBe('PAYOUT_PENDING');
      expect(ctx.bitcoinDeepa.createCollect).toHaveBeenCalledTimes(2);
      for (const call of ctx.bitcoinDeepa.createCollect.mock.calls) {
        expect(call[3]).toBe(q.id);
      }
      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(1);
    });

    describe('waiting for the user to approve', () => {
      const pending = () => collectOk({ status: 'pending' });
      /** Order reads sync with the bot at most every 3s */
      const clearReadThrottle = (id: string) =>
        ctx.app.get(RedisService).del(CacheKeys.sell.collectSync(id));
      const confirmPending = async () => {
        ctx.bitcoinDeepa.createCollect.mockResolvedValueOnce(pending());
        ctx.bitcoinDeepa.getCollect.mockResolvedValue(pending());
        const q = await quote();
        const res = await asUser(ctx, USER)
          .post(`/sell/orders/${q.id}/confirm`)
          .expect(200);
        return { q, body: res.body as Record<string, any> };
      };

      it('stays COLLECTING with the deadline until the payment arrives', async () => {
        const { q, body } = await confirmPending();
        expect(body).toMatchObject({
          status: 'COLLECTING',
          collect: { state: 'pending', payInApp: true },
        });
        const deadline = new Date(body.collect.expiresAt).getTime();
        expect(deadline - Date.now()).toBeGreaterThan(290_000);
        expect(deadline - Date.now()).toBeLessThanOrEqual(300_000);
        expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();

        // Approved in the bot chat, Confirm still needed (above the allowance)
        ctx.bitcoinDeepa.getCollect.mockResolvedValue(
          collectOk({ transferStatus: 'awaiting_confirmation' }),
        );
        await clearReadThrottle(q.id);
        const waiting = await asUser(ctx, USER)
          .get(`/sell/orders/${q.id}`)
          .expect(200);
        expect(waiting.body).toMatchObject({
          status: 'COLLECTING',
          collect: { state: 'awaiting_confirmation' },
        });

        // Paid: the order read moves it on and the payout starts
        ctx.bitcoinDeepa.getCollect.mockResolvedValue(
          collectOk({ paid: true }),
        );
        await clearReadThrottle(q.id);
        const paid = await asUser(ctx, USER)
          .get(`/sell/orders/${q.id}`)
          .expect(200);
        expect(paid.body).toMatchObject({
          status: 'PAYOUT_PENDING',
          collect: null,
        });
        expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(1);
      });

      it('declined in the bot: nothing sold', async () => {
        const { q } = await confirmPending();
        ctx.bitcoinDeepa.getCollect.mockResolvedValue(
          collectOk({ status: 'declined' }),
        );
        await settlement.syncCollects();
        const res = await asUser(ctx, USER)
          .get(`/sell/orders/${q.id}`)
          .expect(200);
        expect(res.body).toMatchObject({
          status: 'EXPIRED',
          failureReason: 'You declined the payment. Nothing was sold.',
        });
      });

      it('a failed payment (low balance) ends the sale', async () => {
        const { q } = await confirmPending();
        ctx.bitcoinDeepa.getCollect.mockResolvedValue(
          collectOk({
            transferStatus: 'failed',
            transfer: {
              id: 'p2p-col-test-1',
              status: 'failed',
              error: 'Insufficient balance.',
            },
          }),
        );
        await settlement.syncCollects();
        const res = await asUser(ctx, USER)
          .get(`/sell/orders/${q.id}`)
          .expect(200);
        expect(res.body).toMatchObject({
          status: 'EXPIRED',
          failureReason: 'Not enough sats in your wallet.',
        });
        expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();
      });

      it('withdraws the request once the window has passed', async () => {
        const { q } = await confirmPending();
        await ctx
          .knex('sell_order')
          .where({ id: q.id })
          .update({ collect_expires_at: new Date(Date.now() - 1000) });
        await settlement.syncCollects();
        expect(ctx.bitcoinDeepa.cancelCollect).toHaveBeenCalledWith(
          'col-test-1',
        );
        expect((await order(q.id)).status).toBe('EXPIRED');
      });

      it('the user approving just before the cancel wins: the sale goes on', async () => {
        const { q } = await confirmPending();
        await ctx
          .knex('sell_order')
          .where({ id: q.id })
          .update({ collect_expires_at: new Date(Date.now() - 1000) });
        ctx.bitcoinDeepa.cancelCollect.mockResolvedValueOnce({
          kind: 'refused',
          status: 409,
          code: 'request_closed',
          message: 'This request is approved.',
        });
        ctx.bitcoinDeepa.getCollect
          .mockResolvedValueOnce(pending())
          .mockResolvedValueOnce(collectOk({ paid: true }));
        await settlement.syncCollects();
        expect((await order(q.id)).status).toBe('PAYOUT_PENDING');
      });

      it('order reads ask the bot at most every few seconds', async () => {
        const { q } = await confirmPending();
        ctx.bitcoinDeepa.getCollect.mockClear();
        for (let i = 0; i < 3; i++) {
          await asUser(ctx, USER).get(`/sell/orders/${q.id}`).expect(200);
        }
        expect(ctx.bitcoinDeepa.getCollect).toHaveBeenCalledTimes(1);
      });

      it('our own config failing (auth) leaves sales open with one alert', async () => {
        const a = await confirmPending();
        const b = await confirmPending();
        logAlert.mockClear();
        ctx.bitcoinDeepa.getCollect.mockResolvedValue({
          kind: 'refused',
          status: 403,
          code: 'auth',
          message: 'Access denied',
        });
        await settlement.syncCollects();
        await settlement.syncCollects();
        expect((await order(a.q.id)).status).toBe('COLLECTING');
        expect((await order(b.q.id)).status).toBe('COLLECTING');
        expect(logAlert).toHaveBeenCalledTimes(1);

        // fixed: they move on
        ctx.bitcoinDeepa.getCollect.mockResolvedValue(
          collectOk({ paid: true }),
        );
        await settlement.syncCollects();
        expect((await order(a.q.id)).status).toBe('PAYOUT_PENDING');
      });

      it('a request the bot no longer knows (404) goes to a human', async () => {
        const { q } = await confirmPending();
        ctx.bitcoinDeepa.getCollect.mockResolvedValue({
          kind: 'refused',
          status: 404,
          code: 'not_found',
          message: 'Request not found.',
        });
        await settlement.syncCollects();
        expect((await order(q.id)).status).toBe('NEEDS_REVIEW');
        expect(logAlert).toHaveBeenCalledWith(
          'Sell',
          expect.stringContaining('col-test-1'),
        );
      });

      it("a paid request that doesn't match the order starts no payout", async () => {
        const { q } = await confirmPending();
        ctx.bitcoinDeepa.getCollect.mockResolvedValue(
          collectOk({ paid: true, amount: 1 }),
        );
        await settlement.syncCollects();
        expect((await order(q.id)).status).toBe('NEEDS_REVIEW');
        expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();
      });

      it('with the mock on, a sale left COLLECTING is treated as paid', async () => {
        const { q } = await confirmPending();
        process.env.BITCOINDEEPA_COLLECT_MOCK = 'true';
        try {
          ctx.bitcoinDeepa.getCollect.mockClear();
          await settlement.syncCollects();
        } finally {
          process.env.BITCOINDEEPA_COLLECT_MOCK = 'false';
        }
        expect(ctx.bitcoinDeepa.getCollect).not.toHaveBeenCalled();
        expect((await order(q.id)).status).toBe('PAYOUT_PENDING');
      });

      it('the user can cancel before paying', async () => {
        const { q } = await confirmPending();
        const res = await asUser(ctx, USER)
          .post(`/sell/orders/${q.id}/cancel`)
          .expect(200);
        expect(res.body.status).toBe('EXPIRED');
        expect(ctx.bitcoinDeepa.cancelCollect).toHaveBeenCalledWith(
          'col-test-1',
        );
      });

      describe('paying in the app (P2P on)', () => {
        beforeEach(() => {
          ctx.p2pBot.isConfigured.mockReturnValue(true);
          ctx.p2pBot.request.mockReset();
        });

        it('approves as the session user (X-BDB-User), then the payout starts', async () => {
          const { q, body } = await confirmPending();
          expect(body.collect.payInApp).toBe(true);
          ctx.p2pBot.request.mockResolvedValue({
            status: 200,
            body: { id: 'p2p-col-test-1', status: 'completed' },
          });
          ctx.bitcoinDeepa.getCollect.mockResolvedValue(
            collectOk({ paid: true }),
          );
          const res = await asUser(ctx, USER)
            .post(`/sell/orders/${q.id}/pay`)
            .expect(200);
          expect(res.body.status).toBe('PAYOUT_PENDING');
          expect(ctx.p2pBot.request).toHaveBeenCalledWith(
            'POST',
            '/api/v1/p2p/collect/col-test-1/approve',
            { kind: 'user', telegramId: USER },
            {},
          );
        });

        it('a user the bot has not linked gets 401 relogin_required', async () => {
          const { q } = await confirmPending();
          ctx.p2pBot.request.mockResolvedValue({
            status: 403,
            body: { code: 'login_required', message: 'Log in first.' },
          });
          const res = await asUser(ctx, USER)
            .post(`/sell/orders/${q.id}/pay`)
            .expect(401);
          expect(res.body.code).toBe('relogin_required');
        });

        it('refuses after the window (410) and withdraws the request', async () => {
          const { q } = await confirmPending();
          await ctx
            .knex('sell_order')
            .where({ id: q.id })
            .update({ collect_expires_at: new Date(Date.now() - 1000) });
          await asUser(ctx, USER).post(`/sell/orders/${q.id}/pay`).expect(410);
          expect(ctx.p2pBot.request).not.toHaveBeenCalled();
          expect((await order(q.id)).status).toBe('EXPIRED');
        });
      });
    });

    it('CeyPay rejecting the payout (no float) refunds the sats', async () => {
      ctx.ceyPay.createOfframp.mockRejectedValueOnce(
        new CeyPayError('Insufficient float balance', 422, false),
      );
      const q = await quote();
      const res = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(200);
      expect(res.body.status).toBe('REFUNDED');
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledWith(
        SATS,
        USER,
        `sell-refund:${q.id}`,
      );
      expect(await order(q.id)).toMatchObject({ refunded: true });
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining('float'),
      );
    });

    it('CeyPay unreachable: keeps the sats collected and the cron retries', async () => {
      ctx.ceyPay.createOfframp.mockRejectedValueOnce(
        new CeyPayError('timeout', undefined, true),
      );
      const q = await quote();
      const res = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(200);
      expect(res.body.status).toBe('SATS_COLLECTED');
      expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();

      // past the backoff
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ last_retry_at: new Date(Date.now() - 10 * 60_000) });
      await settlement.retryPayouts();
      expect((await order(q.id)).status).toBe('PAYOUT_PENDING');
      // same externalRef both times: CeyPay dedupes
      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(2);
      for (const [body] of ctx.ceyPay.createOfframp.mock.calls) {
        expect((body as { externalRef: string }).externalRef).toBe(q.id);
      }
    });

    it('gives up after the last attempt and flags it for a human', async () => {
      ctx.ceyPay.createOfframp.mockRejectedValue(
        new CeyPayError('down', 503, true),
      );
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      for (let i = 0; i < 6; i++) {
        await ctx
          .knex('sell_order')
          .where({ id: q.id })
          .update({ last_retry_at: new Date(Date.now() - 24 * 3600_000) });
        await settlement.retryPayouts();
      }
      expect(await order(q.id)).toMatchObject({
        status: 'NEEDS_REVIEW',
        retry_count: 5,
      });
      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(5);
      expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
    });

    describe('a refusal after an attempt that got no answer', () => {
      const pastBackoff = (id: string) =>
        ctx
          .knex('sell_order')
          .where({ id })
          .update({ last_retry_at: new Date(Date.now() - 10 * 60_000) });

      it.each([
        [
          'the quote call',
          () =>
            ctx.ceyPay.getQuote.mockRejectedValueOnce(
              new CeyPayError('Invalid signature', 401, false),
            ),
        ],
        [
          'the off-ramp call',
          () =>
            ctx.ceyPay.createOfframp.mockRejectedValueOnce(
              new CeyPayError('Insufficient float balance', 422, false),
            ),
        ],
      ])(
        'is not refunded when %s refuses: the first payout may exist',
        async (_, refuseRetry) => {
          // Attempt 1: the off-ramp request went out, no answer came back
          ctx.ceyPay.createOfframp.mockRejectedValueOnce(
            new CeyPayError('timeout', undefined, true),
          );
          const q = await quote();
          await asUser(ctx, USER)
            .post(`/sell/orders/${q.id}/confirm`)
            .expect(200);
          expect((await order(q.id)).status).toBe('SATS_COLLECTED');

          refuseRetry();
          await pastBackoff(q.id);
          await settlement.retryPayouts();

          expect(await order(q.id)).toMatchObject({
            status: 'NEEDS_REVIEW',
            refunded: false,
          });
          expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
          expect(logAlert).toHaveBeenCalledWith(
            'Sell',
            expect.stringContaining(
              `were NOT refunded: check CeyPay for externalRef ${q.id}`,
            ),
          );
        },
      );

      it('is not refunded when the bank account was un-verified meanwhile', async () => {
        ctx.ceyPay.createOfframp.mockRejectedValueOnce(
          new CeyPayError('timeout', undefined, true),
        );
        const q = await quote();
        await asUser(ctx, USER)
          .post(`/sell/orders/${q.id}/confirm`)
          .expect(200);
        await ctx
          .knex('user_bank_account')
          .where({ id: bankId })
          .update({ status: 'REJECTED' });

        await pastBackoff(q.id);
        await settlement.retryPayouts();
        expect((await order(q.id)).status).toBe('NEEDS_REVIEW');
        expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
      });

      it('is still refunded when no off-ramp request was ever sent', async () => {
        const q = await quote();
        // Attempt 1 never got past the quote (CeyPay down): nothing to dedupe
        ctx.ceyPay.getQuote.mockRejectedValueOnce(
          new CeyPayError('down', 503, true),
        );
        await asUser(ctx, USER)
          .post(`/sell/orders/${q.id}/confirm`)
          .expect(200);
        expect(await order(q.id)).toMatchObject({
          status: 'SATS_COLLECTED',
          fx_lock_id: null,
        });
        expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();

        ctx.ceyPay.createOfframp.mockRejectedValueOnce(
          new CeyPayError('Insufficient float balance', 422, false),
        );
        await pastBackoff(q.id);
        await settlement.retryPayouts();
        expect(await order(q.id)).toMatchObject({
          status: 'REFUNDED',
          refunded: true,
        });
        expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
      });
    });

    it('hands a collected order with no attempts left to a human', async () => {
      // The process died during the 5th attempt: nothing parked the order
      const stuck = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: stuck.id })
        .update({
          status: 'SATS_COLLECTED',
          retry_count: 5,
          last_retry_at: ctx.knex.raw("now() - interval '6 minutes'"),
          updated_at: ctx.knex.raw("now() - interval '6 minutes'"),
        });
      // The 5th attempt of this one is still running
      const running = await quote();
      await ctx.knex('sell_order').where({ id: running.id }).update({
        status: 'SATS_COLLECTED',
        retry_count: 5,
        last_retry_at: ctx.knex.fn.now(),
      });
      // This one is waiting out the backoff before its last attempt
      const waiting = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: waiting.id })
        .update({
          status: 'SATS_COLLECTED',
          retry_count: 4,
          last_retry_at: ctx.knex.raw("now() - interval '6 minutes'"),
          updated_at: ctx.knex.raw("now() - interval '6 minutes'"),
        });

      await settlement.retryPayouts();
      expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();
      await settlement.recoverStuckOrders();

      expect(await order(stuck.id)).toMatchObject({
        status: 'NEEDS_REVIEW',
        failure_reason: 'No payout after 5 attempts',
      });
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining(`check CeyPay for externalRef ${stuck.id}`),
      );
      expect(logAlert).not.toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining(running.id),
      );
      expect((await order(running.id)).status).toBe('SATS_COLLECTED');
      expect((await order(waiting.id)).status).toBe('SATS_COLLECTED');
    });

    it('the retry cron leaves a just-collected order to confirm', async () => {
      const q = await quote();
      // setStatus is private: reached here to act between two of its updates
      const sell = ctx.app.get<
        SellService,
        {
          setStatus: (
            ...args: unknown[]
          ) => Promise<{ status: string } | undefined>;
        }
      >(SellService);
      const setStatus = sell.setStatus.bind(sell);
      let sentByCron: number | undefined;
      const spy = jest
        .spyOn(sell, 'setStatus')
        .mockImplementation(async (...args) => {
          const row: { status: string } | undefined = await setStatus(...args);
          if (row?.status === 'SATS_COLLECTED') {
            // The cron fires right after the collect is committed, before
            // confirm has sent its payout request
            await settlement.retryPayouts();
            sentByCron = ctx.ceyPay.createOfframp.mock.calls.length;
          }
          return row;
        });
      try {
        await asUser(ctx, USER)
          .post(`/sell/orders/${q.id}/confirm`)
          .expect(200);
      } finally {
        spy.mockRestore();
      }

      expect(sentByCron).toBe(0);
      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(1);
      // confirm's own attempt is the first one
      expect(await order(q.id)).toMatchObject({
        status: 'PAYOUT_PENDING',
        retry_count: 1,
      });
    });

    it('two retries of the same order send one payout request', async () => {
      const q = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({
          status: 'SATS_COLLECTED',
          retry_count: 1,
          last_retry_at: new Date(Date.now() - 10 * 60_000),
        });
      const sell = ctx.app.get(SellService);
      // Two instances that both read the order as due
      await Promise.all([sell.createPayout(q.id), sell.createPayout(q.id)]);
      await sell.createPayout(q.id);

      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(1);
      expect(await order(q.id)).toMatchObject({
        status: 'PAYOUT_PENDING',
        retry_count: 2,
      });
    });

    it("a new quote while confirming the old one doesn't deadlock", async () => {
      const q = await quote();
      const account = await ctx
        .knex('user_bank_account')
        .where({ id: bankId })
        .first();
      // What quote() does, step by step: expire the old quote (locks its
      // row), then insert the new one (FK share lock on the member's row).
      const trx = await ctx.knex.transaction();
      try {
        await trx('sell_order')
          .where({ id: q.id })
          .update({ status: 'EXPIRED' });
        // confirm now locks the member, then waits for the order row
        const confirming = asUser(ctx, USER)
          .post(`/sell/orders/${q.id}/confirm`)
          .then((res) => res);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const copy = (await order(q.id)) as Record<string, unknown>;
        delete copy.id;
        delete copy.created_at;
        delete copy.updated_at;
        await trx('sell_order').insert({
          ...copy,
          user_bank_account_id: account.id,
          status: 'QUOTED',
        });
        await trx.commit();

        // The old quote is gone: nothing was moved
        expect((await confirming).status).toBe(410);
      } finally {
        if (!trx.isCompleted()) await trx.rollback();
      }
      expect(ctx.bitcoinDeepa.createCollect).not.toHaveBeenCalled();
    });

    it('a failed bank transfer refunds the sats', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const row = await order(q.id);
      let statusDuringRefund: string | undefined;
      ctx.bitcoinDeepa.transferFunds.mockImplementationOnce(async () => {
        statusDuringRefund = (await order(q.id)).status;
        return { success: true };
      });

      await webhook({
        event: 'payment.failed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
        failureReason: 'Invalid account',
      }).expect(200);
      expect(await order(q.id)).toMatchObject({
        status: 'REFUNDED',
        refunded: true,
        failure_reason: 'Invalid account',
      });
      // a refund in progress is REFUNDING, not "needs review"
      expect(statusDuringRefund).toBe('REFUNDING');
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);

      // CeyPay later says it paid after all: the member has both, so alert
      await webhook({
        event: 'payment.completed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
        bankRef: 'BOC-9',
      }).expect(200);
      expect((await order(q.id)).status).toBe('REFUNDED');
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining('may have both the LKR and the sats'),
      );

      // replayed webhook: no second refund
      await webhook({
        event: 'payment.failed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
        failureReason: 'Invalid account',
      }).expect(200);
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    });

    it('a refund that times out is left for a human', async () => {
      ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
        success: false,
        outcome_unknown: true,
      });
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const row = await order(q.id);
      await webhook({
        event: 'payment.failed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
      }).expect(200);
      expect(await order(q.id)).toMatchObject({
        status: 'NEEDS_REVIEW',
        refunded: false,
      });
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining(`sell-refund:${q.id}`),
      );
    });

    it('rejects unsigned, tampered or stale webhooks', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const row = await order(q.id);
      const body = {
        event: 'payment.completed',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
        bankRef: 'X',
      };

      await request(ctx.app.getHttpServer())
        .post('/sell/ceypay-webhook')
        .send(body)
        .expect(401);

      const { headers } = ceypayWebhook(body);
      await request(ctx.app.getHttpServer())
        .post('/sell/ceypay-webhook')
        .set(headers)
        .send(JSON.stringify({ ...body, bankRef: 'Y' }))
        .expect(401);

      await webhook(body, Date.now() - 10 * 60_000).expect(401);
      expect((await order(q.id)).status).toBe('PAYOUT_PENDING');
    });

    it('acknowledges event types it does not handle', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const row = await order(q.id);
      await webhook({
        event: 'payment.processing',
        paymentId: row.ceypay_payment_id,
        externalRef: q.id,
      }).expect(200);
      expect((await order(q.id)).status).toBe('PAYOUT_PENDING');
    });

    it('alerts once about a payout still pending after 2 hours', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ created_at: ctx.knex.raw("now() - interval '3 hours'") });
      await settlement.alertStalePayouts();
      await settlement.alertStalePayouts();
      const stale = logAlert.mock.calls.filter(([, text]) =>
        String(text).includes('still pending after 2h'),
      );
      expect(stale).toHaveLength(1);
    });

    it("ignores a webhook whose payment doesn't match the order", async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      await webhook({
        event: 'payment.completed',
        paymentId: randomUUID(),
        externalRef: q.id,
      }).expect(200);
      expect((await order(q.id)).status).toBe('PAYOUT_PENDING');
    });

    it('polls CeyPay for payouts whose webhook never came', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const row = await order(q.id);
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ updated_at: new Date(Date.now() - 15 * 60_000) });
      ctx.ceyPay.getOfframp.mockResolvedValueOnce({
        paymentId: row.ceypay_payment_id,
        status: 'COMPLETED',
        bankRef: 'POLL-1',
      });

      await settlement.pollPendingPayouts();
      expect(ctx.ceyPay.getOfframp).toHaveBeenCalledWith(row.ceypay_payment_id);
      expect(await order(q.id)).toMatchObject({
        status: 'COMPLETED',
        bank_ref: 'POLL-1',
      });
    });

    it("a bank account can't be removed while a sale is in flight", async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      await asUser(ctx, USER).delete(`/bank-accounts/${bankId}`).expect(409);
    });

    it('expires stale quotes', async () => {
      const q = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ expires_at: new Date(Date.now() - 1000) });
      await settlement.expireQuotes();
      expect((await order(q.id)).status).toBe('EXPIRED');
    });

    it("lists the user's orders without expired quotes", async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      await quote(); // live quote
      const res = await asUser(ctx, USER).get('/sell/orders').expect(200);
      expect(res.body).toHaveLength(2);
      await asUser(ctx, USER).get(`/sell/orders/${q.id}`).expect(200);
    });
  });
});
