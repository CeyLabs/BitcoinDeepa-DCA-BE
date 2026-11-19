import * as request from 'supertest';
import {
  createTestApp,
  resetData,
  payhereNotification,
  sats,
  TestContext,
  USER,
  OTHER_USER,
  PACKAGE_WEEKLY,
} from './support/test-app';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { TelegramLoggerService } from '../src/modules/telegram-logger/telegram-logger.service';
import { TransactionService } from '../src/modules/transaction/transaction.service';

describe('One-time buy (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const auth = (userId = USER) => ({
    Authorization: `Bearer ${ctx.tokenFor(userId)}`,
  });

  /** Create a one-time checkout for USER and return the parsed link. */
  async function newBuy(amount_lkr = 1000, userId = USER) {
    const res = await http()
      .post('/buy/payhere-link')
      .set(auth(userId))
      .send({ amount_lkr })
      .expect(201);
    const link = new URL(res.body.link as string);
    expect(res.body.order_id).toBe(link.searchParams.get('order_id'));
    return {
      link,
      order_id: link.searchParams.get('order_id')!,
      amount: link.searchParams.get('amount')!,
    };
  }
  const notify = (fields: Parameters<typeof payhereNotification>[0]) =>
    http()
      .post('/transaction/payhere-webhook')
      .type('form')
      .send(payhereNotification(fields));
  const tx = (payhere_pay_id: string) =>
    ctx.knex('transaction').where({ payhere_pay_id }).first();

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(() => resetData(ctx));

  describe('checkout link', () => {
    it('builds a one-off checkout (no recurrence) and stores the order', async () => {
      const { link, order_id, amount } = await newBuy(2500);
      expect(amount).toBe('2500.00');
      expect(link.searchParams.get('recurrence')).toBeNull();
      expect(link.searchParams.get('duration')).toBeNull();
      expect(link.searchParams.get('items')).toBe('Bitcoin purchase');
      // PayHere appends nothing on return; the app reads the order from here
      expect(
        new URL(link.searchParams.get('return_url')!).searchParams.get(
          'buy_order',
        ),
      ).toBe(order_id);
      expect(
        new URL(link.searchParams.get('cancel_url')!).searchParams.get(
          'buy_order',
        ),
      ).toBe(order_id);

      const order = await ctx.knex('buy_order').where({ order_id }).first();
      expect(order).toMatchObject({
        user_id: USER,
        kind: 'ONE_TIME',
        package_id: null,
        currency: 'LKR',
      });
      expect(Number(order.amount)).toBe(2500);
    });

    it('enforces the per-buy min and max', async () => {
      await http()
        .post('/buy/payhere-link')
        .set(auth())
        .send({ amount_lkr: 99 })
        .expect(400);
      await http()
        .post('/buy/payhere-link')
        .set(auth())
        .send({ amount_lkr: 100_001 })
        .expect(400);
      await http()
        .post('/buy/payhere-link')
        .set(auth())
        .send({ amount_lkr: 10.5 })
        .expect(400);
    });

    it('requires approved KYC', async () => {
      await http()
        .post('/buy/payhere-link')
        .set(auth(OTHER_USER))
        .send({ amount_lkr: 1000 })
        .expect(403);
    });

    it('counts paid buys and unexpired unpaid checkouts towards the 24h limit', async () => {
      // paid: 100,000
      const first = await newBuy(100_000);
      await notify({
        order_id: first.order_id,
        payment_id: 'B1',
        payhere_amount: first.amount,
      }).expect(200);
      // unpaid but still payable: reserved
      await newBuy(100_000);

      // 200,000 used of 250,000
      const res = await http()
        .post('/buy/payhere-link')
        .set(auth())
        .send({ amount_lkr: 50_001 })
        .expect(400);
      expect(res.body.message).toContain('50,000');
      await newBuy(50_000);

      // an expired unpaid checkout no longer reserves its amount
      await ctx
        .knex('buy_order')
        .where({ user_id: USER, kind: 'ONE_TIME' })
        .whereNotIn(
          'order_id',
          ctx
            .knex('transaction')
            .select('payhere_order_id')
            .whereNotNull('payhere_order_id'),
        )
        .update({ expires_at: ctx.knex.raw("now() - interval '1 minute'") });
      await newBuy(100_000);
    });

    it('gives each checkout an expiry', async () => {
      const { order_id } = await newBuy(1000);
      const order = await ctx.knex('buy_order').where({ order_id }).first();
      const minutes =
        (new Date(order.expires_at).getTime() -
          new Date(order.created_at).getTime()) /
        60_000;
      expect(Math.round(minutes)).toBe(30);
    });

    it('limits checkouts per hour (429)', async () => {
      for (let i = 0; i < 10; i++) await newBuy(100);
      await http()
        .post('/buy/payhere-link')
        .set(auth())
        .send({ amount_lkr: 100 })
        .expect(429);
    });

    it('is allowed while a subscription is active', async () => {
      const res = await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(201);
      const subOrder = new URL(res.body.link as string).searchParams.get(
        'order_id',
      )!;
      await notify({
        order_id: subOrder,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);

      await newBuy(1000);
    });

    it('shows a minimum, maximum and fees on the price endpoint', async () => {
      const res = await http().get('/buy/price').set(auth()).expect(200);
      expect(res.body).toEqual({
        btcLkrPrice: 21_450_000,
        paymentProcessorFeeBasisPoints: 100,
        bitcoindeepaFeeBasisPoints: 100,
        minLkr: 100,
        maxLkr: 100_000,
        dailyMaxLkr: 250_000,
      });
    });
  });

  describe('webhook', () => {
    it('records a priced ONE_TIME transaction owned by the order user', async () => {
      const { order_id, amount } = await newBuy(1000);
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);

      const row = await tx('B1');
      expect(row).toMatchObject({
        kind: 'ONE_TIME',
        user_id: USER,
        payhere_order_id: order_id,
        payhere_sub_id: null,
        status: 'SUCCESS',
        settled: false,
      });
      expect(Number(row.gross_amount)).toBe(1000);
      expect(Number(row.net_amount)).toBe(980);
      expect(Number(row.satoshis_purchased)).toBe(sats(980));
      // no subscription is created
      expect(await ctx.knex('subscription').count('* as c').first()).toEqual({
        c: '0',
      });
    });

    it('rejects a signed amount that differs from the order', async () => {
      const { order_id } = await newBuy(1000);
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: '1.00',
      }).expect(400);
      expect(await tx('B1')).toBeUndefined();
    });

    it('rejects a one-time order sent as a subscription and leaves cancelling to a human', async () => {
      const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
      // a subscription we know (e.g. from before order binding)
      await ctx.knex('subscription').insert({
        payhere_sub_id: 'S-known',
        user_id: OTHER_USER,
        package_id: PACKAGE_WEEKLY,
        is_active: true,
      });
      for (const subscription_id of ['S9', 'S-known']) {
        const { order_id, amount } = await newBuy(1000);
        await notify({
          order_id,
          payment_id: `B-${subscription_id}`,
          subscription_id,
          payhere_amount: amount,
        }).expect(400);
        expect(await tx(`B-${subscription_id}`)).toBeUndefined();
      }
      // subscription_id isn't signed: never cancel or change anything
      expect(ctx.payHereCancel).not.toHaveBeenCalled();
      expect(
        await ctx.knex('subscription').where({ payhere_sub_id: 'S9' }).first(),
      ).toBeUndefined();
      expect(
        await ctx
          .knex('subscription')
          .where({ payhere_sub_id: 'S-known' })
          .first(),
      ).toMatchObject({ is_active: true, payhere_order_id: null });
      expect(alert).toHaveBeenCalledWith(
        'PayHere webhook',
        expect.stringContaining('cancel it and refund the charge in PayHere'),
      );
    });

    it('follows the forward-only status rules', async () => {
      const { order_id, amount } = await newBuy(1000);
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
        status_code: '0',
      }).expect(200);
      expect(await tx('B1')).toMatchObject({ status: 'PENDING' });

      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);
      expect(await tx('B1')).toMatchObject({ status: 'SUCCESS' });

      // a late PENDING never moves it back
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
        status_code: '0',
      }).expect(200);
      expect(await tx('B1')).toMatchObject({ status: 'SUCCESS' });
    });

    it('holds a second payment of the same order instead of settling it', async () => {
      const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
      const { order_id, amount } = await newBuy(1000);
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);
      await notify({
        order_id,
        payment_id: 'B2',
        payhere_amount: amount,
      }).expect(200);
      expect(await tx('B1')).toMatchObject({ hold_reason: null });
      expect((await tx('B2')).hold_reason).toContain('paid twice');
      expect(alert).toHaveBeenCalledWith(
        'PayHere webhook',
        expect.stringContaining('is HELD'),
      );

      await ctx.app.get(SettlementService).retryUnsettledTransactions();
      const memos = (
        ctx.bitcoinDeepa.transferFunds.mock.calls as unknown[][]
      ).map((c) => c[2]);
      expect(memos).toEqual(['One-time BTC purchase (Ref: B1)']);
    });

    it('holds one of two payments of the same order that arrive at the same time', async () => {
      // Make the race real: each payment, after its hold check but before
      // it commits, waits (up to 500ms) for the other's check. Unlocked, both
      // checks run before either commits and neither sees the other; with the
      // member lock the second can't start its check until the first commits.
      type HoldCheck = (...args: unknown[]) => Promise<string | null>;
      const service = ctx.app.get<
        TransactionService,
        { oneTimeHoldReason: HoldCheck }
      >(TransactionService);
      const original: HoldCheck = service.oneTimeHoldReason.bind(service);
      let checked = 0;
      const spy = jest
        .spyOn(service, 'oneTimeHoldReason')
        .mockImplementation(async (...args: unknown[]) => {
          const reason: string | null = await original(...args);
          checked++;
          const until = Date.now() + 500;
          while (checked < 2 && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 10));
          }
          return reason;
        });

      const { order_id, amount } = await newBuy(1000);
      await Promise.all([
        notify({ order_id, payment_id: 'B1', payhere_amount: amount }).expect(
          200,
        ),
        notify({ order_id, payment_id: 'B2', payhere_amount: amount }).expect(
          200,
        ),
      ]);
      spy.mockRestore();
      const held = [await tx('B1'), await tx('B2')].filter(
        (t: { hold_reason: string | null }) => t.hold_reason,
      );
      expect(held).toHaveLength(1);
    });

    it('holds a payment made after the checkout expired', async () => {
      const { order_id, amount } = await newBuy(1000);
      await ctx
        .knex('buy_order')
        .where({ order_id })
        .update({ expires_at: ctx.knex.raw("now() - interval '1 hour'") });
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);
      expect((await tx('B1')).hold_reason).toContain('expired');
    });

    it('holds a payment that takes the member over the 24h limit', async () => {
      const big = await newBuy(100_000);
      const small = await newBuy(10_000);
      await notify({
        order_id: big.order_id,
        payment_id: 'B1',
        payhere_amount: big.amount,
      }).expect(200);
      // e.g. other payments since: the member is now at 245,000
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'B1' })
        .update({ gross_amount: 245_000 });
      await notify({
        order_id: small.order_id,
        payment_id: 'B2',
        payhere_amount: small.amount,
      }).expect(200);
      expect((await tx('B2')).hold_reason).toContain(
        'over the 250000 LKR limit',
      );
    });

    it('settles a held payment once a human releases it', async () => {
      const settlement = ctx.app.get(SettlementService);
      const { order_id, amount } = await newBuy(1000);
      await ctx
        .knex('buy_order')
        .where({ order_id })
        .update({ expires_at: ctx.knex.raw("now() - interval '1 hour'") });
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);
      await settlement.retryUnsettledTransactions();
      expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
      const held = await http()
        .get(`/buy/orders/${order_id}`)
        .set(auth())
        .expect(200);
      expect(held.body).toMatchObject({ status: 'SUCCESS', held: true });

      // retry resets don't release holds
      await http()
        .post('/transaction/reset-retry-count/B1')
        .set('x-admin-key', process.env.ADMIN_API_KEY!)
        .expect(201);
      expect((await tx('B1')).hold_reason).toContain('expired');

      await http()
        .post('/transaction/release-hold/B1')
        .set('x-admin-key', process.env.ADMIN_API_KEY!)
        .expect(201);
      expect(await tx('B1')).toMatchObject({ hold_reason: null });
      await http()
        .post('/transaction/release-hold/B1')
        .set('x-admin-key', process.env.ADMIN_API_KEY!)
        .expect(404);
      await settlement.retryUnsettledTransactions();
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
      expect(await tx('B1')).toMatchObject({ settled: true });
    });
  });

  describe('order status, history and settlement', () => {
    it('reports the order until it is settled', async () => {
      const { order_id, amount } = await newBuy(1000);
      const before = await http()
        .get(`/buy/orders/${order_id}`)
        .set(auth())
        .expect(200);
      expect(before.body).toMatchObject({
        order_id,
        amount_lkr: 1000,
        status: 'AWAITING_PAYMENT',
        settled: false,
        held: false,
      });

      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);
      await ctx.app.get(SettlementService).retryUnsettledTransactions();

      const after = await http()
        .get(`/buy/orders/${order_id}`)
        .set(auth())
        .expect(200);
      expect(after.body).toMatchObject({
        status: 'SUCCESS',
        payhere_pay_id: 'B1',
        satoshis: sats(980),
        settled: true,
      });

      // another user can't see it
      await http()
        .get(`/buy/orders/${order_id}`)
        .set(auth(OTHER_USER))
        .expect(404);
    });

    it('settles only after PayHere lists the payment, with a one-time memo', async () => {
      const settlement = ctx.app.get(SettlementService);
      const { order_id, amount } = await newBuy(1000);
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);

      ctx.payHereOrderPayments.mockResolvedValueOnce([]);
      await settlement.retryUnsettledTransactions();
      expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
      expect(ctx.payHereOrderPayments).toHaveBeenCalledWith(order_id);

      // past the 2-minute backoff
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'B1' })
        .update({ last_retry_at: ctx.knex.raw("now() - interval '1 hour'") });
      await settlement.retryUnsettledTransactions();
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
      const [sent, to, memo] = ctx.bitcoinDeepa.transferFunds.mock.calls[0];
      expect(Number(sent)).toBe(sats(980));
      expect(to).toBe(USER);
      expect(memo).toBe('One-time BTC purchase (Ref: B1)');
      expect(await tx('B1')).toMatchObject({ settled: true });
    });

    it('shows one-time buys next to subscription charges in history and summary', async () => {
      const res = await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(201);
      const subOrder = new URL(res.body.link as string).searchParams.get(
        'order_id',
      )!;
      await notify({
        order_id: subOrder,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      const { order_id, amount } = await newBuy(2000);
      await notify({
        order_id,
        payment_id: 'B1',
        payhere_amount: amount,
      }).expect(200);

      const list = await http()
        .get('/transaction/list?limit=10')
        .set(auth())
        .expect(200);
      expect(list.body.total_count).toBe(2);
      const byId = Object.fromEntries(
        (
          list.body.transactions as {
            payhere_pay_id: string;
            kind: string;
            package_name: string | null;
          }[]
        ).map((t) => [t.payhere_pay_id, t]),
      );
      expect(byId.B1).toMatchObject({ kind: 'ONE_TIME', package_name: null });
      expect(byId.P1).toMatchObject({
        kind: 'RECURRING',
        package_name: 'Shrimp Weekly',
      });

      const summary = await http()
        .get('/transaction/dca-summary')
        .set(auth())
        .expect(200);
      expect(summary.body.dca).toMatchObject({
        balance: sats(980) + sats(1960),
        spent: 980 + 1960,
        fees: 20 + 40,
      });
    });
  });

  describe('bot history', () => {
    const botRow = (
      id: number,
      memo: string | undefined,
      amount: number,
      extra: { direction?: string; success?: boolean } = {},
    ) => ({
      id,
      time: '2026-11-19T12:00:00Z',
      direction: extra.direction ?? 'incoming',
      from_id: 1,
      to_id: Number(USER),
      type: 'transfer',
      amount,
      amount_lkr: '200.00',
      memo,
      success: extra.success ?? true,
    });
    const satsOf = async (payhere_pay_id: string) =>
      Number((await tx(payhere_pay_id)).satoshis_purchased);
    const settle = (...ids: string[]) =>
      ctx
        .knex('transaction')
        .whereIn('payhere_pay_id', ids)
        .update({ settled: true });
    const memo = SettlementService.transferMemo;

    it("marks only the transfers that settled the user's own successful purchases", async () => {
      // P1, P2: plan charges; B1..B4: one-time buys
      const res = await http()
        .post('/subscription/payhere-link')
        .set(auth())
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(201);
      const subOrder = new URL(res.body.link as string).searchParams.get(
        'order_id',
      )!;
      for (const payment_id of ['P1', 'P2']) {
        await notify({
          order_id: subOrder,
          payment_id,
          subscription_id: 'S1',
        }).expect(200);
      }
      for (const payment_id of ['B1', 'B2', 'B3', 'B4']) {
        const buy = await newBuy(1000);
        await notify({
          order_id: buy.order_id,
          payment_id,
          payhere_amount: buy.amount,
        }).expect(200);
      }
      await settle('P1', 'P2', 'B1', 'B2', 'B3');
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'B2' })
        .update({ status: 'CHARGEBACK' });
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'B3' })
        .update({ user_id: OTHER_USER });
      // B4 stays unsettled: a send whose outcome is unknown

      const [p1, p2, b1, b2, b3, b4] = await Promise.all(
        ['P1', 'P2', 'B1', 'B2', 'B3', 'B4'].map(satsOf),
      );
      const rows = [
        botRow(1, memo('P1'), p1),
        botRow(2, `Weekly DCA plan (Ref: P2)`, p2), // older memo format
        botRow(3, memo('B1', 'ONE_TIME'), b1),
        botRow(4, memo('B2', 'ONE_TIME'), b2), // charged back
        botRow(5, memo('B3', 'ONE_TIME'), b3), // someone else's payment
        botRow(6, `lunch (Ref: B1)`, b1 + 1), // own ref, wrong amount
        botRow(7, memo('B1', 'ONE_TIME'), b1, { direction: 'outgoing' }),
        botRow(8, memo('B4', 'ONE_TIME'), b4), // arrived, not marked settled
        botRow(9, memo('B4', 'ONE_TIME'), b4, { success: false }), // failed try
        botRow(10, 'lunch', 1000),
        botRow(11, undefined, 1000),
      ];
      ctx.bitcoinDeepa.getUserTransactions.mockResolvedValueOnce({
        success: true,
        count: rows.length,
        limit: 50,
        offset: 0,
        transactions: rows,
      });

      const history = await http()
        .get('/transaction/bot-history?limit=50&offset=0')
        .set(auth())
        .expect(200);
      expect(history.body.count).toBe(rows.length);
      expect(
        history.body.transactions.map(
          (t: { id: number; purchase_settlement: boolean }) => [
            t.id,
            t.purchase_settlement,
          ],
        ),
      ).toEqual([
        [1, true],
        [2, true],
        [3, true],
        [4, false],
        [5, false],
        [6, false],
        [7, false],
        [8, false],
        [9, true],
        [10, false],
        [11, false],
      ]);
    });

    it('passes a bot failure through unchanged', async () => {
      ctx.bitcoinDeepa.getUserTransactions.mockResolvedValueOnce({
        success: false,
        message: 'bot down',
      });
      const res = await http()
        .get('/transaction/bot-history')
        .set(auth())
        .expect(200);
      expect(res.body).toEqual({ success: false, message: 'bot down' });
    });
  });
});
