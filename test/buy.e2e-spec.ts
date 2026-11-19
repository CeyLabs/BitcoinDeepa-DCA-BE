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

      const order = await ctx.knex('payhere_order').where({ order_id }).first();
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

    it('enforces the rolling 24h limit on paid one-time buys', async () => {
      const first = await newBuy(100_000);
      await notify({
        order_id: first.order_id,
        payment_id: 'B1',
        payhere_amount: first.amount,
      }).expect(200);
      const second = await newBuy(100_000);
      await notify({
        order_id: second.order_id,
        payment_id: 'B2',
        payhere_amount: second.amount,
      }).expect(200);

      // 200,000 used of 250,000
      await newBuy(50_000);
      const res = await http()
        .post('/buy/payhere-link')
        .set(auth())
        .send({ amount_lkr: 50_001 })
        .expect(400);
      expect(res.body.message).toContain('50,000');
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
        btcLkrPrice: 19_500_000,
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

    it('refuses to turn a one-time order into a subscription', async () => {
      const { order_id, amount } = await newBuy(1000);
      await notify({
        order_id,
        payment_id: 'B1',
        subscription_id: 'S9',
        payhere_amount: amount,
      }).expect(400);
      expect(await tx('B1')).toBeUndefined();
      expect(
        await ctx.knex('subscription').where({ payhere_sub_id: 'S9' }).first(),
      ).toBeUndefined();
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

    it('alerts when an order is paid twice', async () => {
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
      expect(alert).toHaveBeenCalledWith(
        'PayHere webhook',
        expect.stringContaining('was paid again'),
      );
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
});
