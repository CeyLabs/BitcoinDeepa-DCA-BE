import * as request from 'supertest';
import { randomUUID } from 'crypto';
import {
  ceypayWebhook,
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
import { CeyPayError } from '../src/modules/ceypay/ceypay.service';
import { TelegramLoggerService } from '../src/modules/telegram-logger/telegram-logger.service';

// 100,000 sats, 1% fee = 1,000 sats; 99,000 sats at 20,000,000 LKR/BTC
const SATS = 100_000;
const AMOUNT_LKR = 19_800;

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

    it('quotes with our own FX, fee taken in sats', async () => {
      const res = await asUser(ctx, USER)
        .post('/sell/quote', { sats: SATS })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'QUOTED',
        sats: SATS,
        feeBasisPoints: 100,
        feeSats: 1000,
        netSats: 99_000,
        btcLkrRate: 20_000_000,
        amountLkr: AMOUNT_LKR,
      });
      // CeyPay is not touched until the user confirms
      expect(ctx.ceyPay.getQuote).not.toHaveBeenCalled();
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

      expect(ctx.bitcoinDeepa.collectFunds).toHaveBeenCalledWith(
        SATS,
        USER,
        `sell:${q.id}`,
      );
      // USDT sized from CeyPay's rate so it pays at least our LKR
      const [usdt] = ctx.ceyPay.getQuote.mock.calls.at(-1) as [string];
      expect(Number(usdt) * CEYPAY_USDT_LKR).toBeGreaterThanOrEqual(AMOUNT_LKR);
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
        expect.stringContaining('19800.00 LKR'),
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

    it('confirming twice collects once', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const again = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(200);
      expect(again.body.status).toBe('PAYOUT_PENDING');
      expect(ctx.bitcoinDeepa.collectFunds).toHaveBeenCalledTimes(1);
      expect(ctx.ceyPay.createOfframp).toHaveBeenCalledTimes(1);
    });

    it("can't confirm someone else's order", async () => {
      const q = await quote();
      await asUser(ctx, '100000002')
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(403); // OTHER_USER has no KYC
      expect(ctx.bitcoinDeepa.collectFunds).not.toHaveBeenCalled();
    });

    it('an expired quote moves nothing', async () => {
      const q = await quote();
      await ctx
        .knex('sell_order')
        .where({ id: q.id })
        .update({ expires_at: new Date(Date.now() - 1000) });
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(410);
      expect((await order(q.id)).status).toBe('EXPIRED');
      expect(ctx.bitcoinDeepa.collectFunds).not.toHaveBeenCalled();
    });

    it('a new quote replaces the previous one', async () => {
      const first = await quote();
      await quote();
      expect((await order(first.id)).status).toBe('EXPIRED');
    });

    it('a rejected collect (e.g. balance spent meanwhile) cancels the quote', async () => {
      ctx.bitcoinDeepa.collectFunds.mockResolvedValueOnce({
        success: false,
        message: 'insufficient balance',
      });
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(400);
      expect((await order(q.id)).status).toBe('EXPIRED');
      expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();
    });

    it('an unknown collect outcome stops everything and alerts', async () => {
      ctx.bitcoinDeepa.collectFunds.mockResolvedValueOnce({
        success: false,
        outcome_unknown: true,
        message: 'timeout',
      });
      const q = await quote();
      const res = await asUser(ctx, USER)
        .post(`/sell/orders/${q.id}/confirm`)
        .expect(200);
      expect(res.body.status).toBe('NEEDS_REVIEW');
      expect(ctx.ceyPay.createOfframp).not.toHaveBeenCalled();
      expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
      expect(logAlert).toHaveBeenCalledWith(
        'Sell',
        expect.stringContaining(q.id),
      );
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

    it('a failed bank transfer refunds the sats', async () => {
      const q = await quote();
      await asUser(ctx, USER).post(`/sell/orders/${q.id}/confirm`).expect(200);
      const row = await order(q.id);

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
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);

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
