import * as request from 'supertest';
import {
  createTestApp,
  resetData,
  payhereNotification,
  sats,
  TestContext,
  BTC_USD,
  USER,
  OTHER_USER,
  PACKAGE_WEEKLY,
  PACKAGE_MONTHLY,
} from './support/test-app';
import { CacheKeys } from '../src/modules/redis/utils/cache-keys.util';
import { TelegramLoggerService } from '../src/modules/telegram-logger/telegram-logger.service';
import { TransactionService } from '../src/modules/transaction/transaction.service';

describe('PayHere webhook (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  /** Create a checkout link for USER and return its order_id. */
  async function newOrder(packageId = PACKAGE_WEEKLY, userId = USER) {
    const res = await http()
      .post('/subscription/payhere-link')
      .set('Authorization', `Bearer ${ctx.tokenFor(userId)}`)
      .send({ package_id: packageId })
      .expect(201);
    const link = new URL(res.body.link as string);
    return {
      order_id: link.searchParams.get('order_id')!,
      amount: link.searchParams.get('amount')!,
    };
  }
  const notify = (fields: Parameters<typeof payhereNotification>[0]) =>
    http()
      .post('/transaction/payhere-webhook')
      .type('form')
      .send(payhereNotification(fields));
  const row = (table: string, where: Record<string, string>) =>
    ctx.knex(table).where(where).first();

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(() => resetData(ctx));

  describe('authentication of notifications', () => {
    it('rejects a bad md5sig with 401 and stores nothing', async () => {
      const { order_id } = await newOrder();
      await http()
        .post('/transaction/payhere-webhook')
        .type('form')
        .send({
          ...payhereNotification({
            order_id,
            payment_id: 'P1',
            subscription_id: 'S1',
          }),
          md5sig: 'BAD',
        })
        .expect(401);
      expect(await ctx.knex('transaction').count('* as c').first()).toEqual({
        c: '0',
      });
    });

    it('rejects an order_id that no checkout link was created for', async () => {
      await notify({
        order_id: 'unknown',
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(400);
      expect(
        await row('subscription', { payhere_sub_id: 'S1' }),
      ).toBeUndefined();
    });

    it('rejects a notification without subscription_id', async () => {
      const { order_id } = await newOrder();
      await notify({ order_id, payment_id: 'P1', subscription_id: '' }).expect(
        400,
      );
    });
  });

  describe('first payment', () => {
    it('creates an active subscription and a priced transaction', async () => {
      const { order_id, amount } = await newOrder();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        payhere_amount: amount,
        message_type: 'AUTHORIZATION_SUCCESS',
      }).expect(200);

      const sub = await row('subscription', { payhere_sub_id: 'S1' });
      expect(sub).toMatchObject({
        user_id: USER,
        package_id: PACKAGE_WEEKLY,
        is_active: true,
        payhere_order_id: order_id,
      });

      const tx = await row('transaction', { payhere_pay_id: 'P1' });
      expect(tx).toMatchObject({ status: 'SUCCESS', settled: false });
      expect(Number(tx.gross_amount)).toBe(1000);
      expect(Number(tx.net_amount)).toBe(980); // 1% PayHere + 1% BitcoinDeepa
      expect(Number(tx.satoshis_purchased)).toBe(sats(980));
    });

    it('takes the owner from the stored order, not the editable custom_1/custom_2 (KYC bypass)', async () => {
      const { order_id } = await newOrder();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        custom_1: OTHER_USER,
        custom_2: PACKAGE_MONTHLY,
      }).expect(200);
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { user_id: USER, package_id: PACKAGE_WEEKLY },
      );
    });

    it('a failed first payment does not create an active subscription', async () => {
      const { order_id } = await newOrder();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        status_code: '-2',
        message_type: 'AUTHORIZATION_FAILED',
      }).expect(200);
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: false },
      );
      // ...so the user can try again
      await newOrder();
    });

    it('a PENDING first payment is activated by its later SUCCESS', async () => {
      const { order_id } = await newOrder();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        status_code: '0',
      }).expect(200);
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: false },
      );
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        status_code: '2',
      }).expect(200);
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: true },
      );
      expect(
        Number(
          (await row('transaction', { payhere_pay_id: 'P1' }))
            .satoshis_purchased,
        ),
      ).toBe(sats(980));
    });
  });

  describe('double checkout and retries', () => {
    let alert: jest.SpyInstance;
    beforeEach(() => {
      alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    });
    afterEach(() => alert.mockRestore());

    it('paying a second open checkout link does not create a second active plan', async () => {
      const first = await newOrder();
      const second = await newOrder(); // opened before either was paid
      await notify({
        ...first,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      await notify({
        ...second,
        payment_id: 'P2',
        subscription_id: 'S2',
      }).expect(200);

      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: true },
      );
      expect(await row('subscription', { payhere_sub_id: 'S2' })).toMatchObject(
        { is_active: false },
      );
      // the duplicate would keep billing a plan the user can't see: cancelled
      expect(ctx.payHereCancel).toHaveBeenCalledWith('S2');
      expect(alert).toHaveBeenCalledWith(
        'PayHere webhook',
        expect.stringContaining('Duplicate subscription S2'),
      );
      expect(alert).toHaveBeenCalledWith(
        'PayHere webhook',
        expect.stringContaining('Cancelled at PayHere'),
      );
    });

    it('first activation waits for the user lock (serialises concurrent checkouts)', async () => {
      // Stand-in for a concurrent webhook of the same user holding the lock.
      // Racing two real requests isn't reliable in a test, so check the
      // mechanism: activation must block until the lock is released.
      const { order_id } = await newOrder();
      const holder = await ctx.knex.transaction();
      // NO KEY UPDATE like the app, so the FK check on the subscription
      // insert isn't what blocks - only the activation lock is.
      await holder('user').where({ id: USER }).forNoKeyUpdate();

      let done = false;
      let pending!: Promise<request.Response>;
      try {
        pending = notify({
          order_id,
          payment_id: 'P1',
          subscription_id: 'S1',
        }).then((res) => {
          done = true;
          return res;
        });
        await new Promise((r) => setTimeout(r, 500));
        expect(done).toBe(false);
      } finally {
        // always release, or a failure would leave the webhook hanging
        await holder.commit();
      }
      expect((await pending).status).toBe(200);
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: true },
      );
    });

    it('a newer declined attempt does not hide the active plan', async () => {
      const first = await newOrder();
      const second = await newOrder();
      await notify({
        ...first,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      await notify({
        ...second,
        payment_id: 'P2',
        subscription_id: 'S2',
        status_code: '-2',
      }).expect(200);

      const auth = { Authorization: `Bearer ${ctx.tokenFor(USER)}` };
      const current = await http()
        .get('/subscription/current')
        .set(auth)
        .expect(200);
      expect(current.body).toMatchObject({ payhere_sub_id: 'S1' });
      await http()
        .post('/subscription/payhere-link')
        .set(auth)
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(409);
      await http().post('/subscription/cancel').set(auth).expect(201);
      expect(ctx.payHereCancel).toHaveBeenCalledWith('S1');
    });

    it('a retry on the same checkout with a new subscription_id is accepted', async () => {
      const { order_id } = await newOrder();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        status_code: '-2',
      }).expect(200);
      await notify({
        order_id,
        payment_id: 'P2',
        subscription_id: 'S2',
      }).expect(200);

      expect(await row('subscription', { payhere_sub_id: 'S2' })).toMatchObject(
        { is_active: true, payhere_order_id: order_id, user_id: USER },
      );
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: false, payhere_order_id: null },
      );
    });

    describe('subscriptions from before order binding (no order_id stored)', () => {
      beforeEach(async () => {
        await ctx.knex('subscription').insert({
          payhere_sub_id: 'S-OLD',
          user_id: USER,
          package_id: PACKAGE_WEEKLY,
          is_active: true,
        });
      });

      it("can't be locked to another user's order by a replayed notification", async () => {
        // attacker's own checkout; its notification went to their server
        await ctx.knex('payhere_order').insert({
          order_id: 'ORDER-ATTACKER',
          user_id: OTHER_USER,
          package_id: PACKAGE_WEEKLY,
        });
        await notify({
          order_id: 'ORDER-ATTACKER',
          payment_id: 'P-REPLAY',
          subscription_id: 'S-OLD',
        }).expect(400);
        expect(
          await row('subscription', { payhere_sub_id: 'S-OLD' }),
        ).toMatchObject({ payhere_order_id: null });

        // the victim's genuine renewal (old order: no payhere_order row) works
        await notify({
          order_id: 'ORDER-OLD',
          payment_id: 'P-RENEWAL',
          subscription_id: 'S-OLD',
        }).expect(200);
        expect(
          await row('subscription', { payhere_sub_id: 'S-OLD' }),
        ).toMatchObject({ payhere_order_id: 'ORDER-OLD' });
      });

      it("binds the user's own new order", async () => {
        const order_id = 'ORDER-OWN';
        await ctx
          .knex('payhere_order')
          .insert({ order_id, user_id: USER, package_id: PACKAGE_WEEKLY });
        await notify({
          order_id,
          payment_id: 'P2',
          subscription_id: 'S-OLD',
        }).expect(200);
        expect(
          await row('subscription', { payhere_sub_id: 'S-OLD' }),
        ).toMatchObject({ payhere_order_id: order_id });
      });
    });

    it("a paid subscription's order_id cannot be taken over", async () => {
      const { order_id } = await newOrder();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      await notify({
        order_id,
        payment_id: 'P2',
        subscription_id: 'S2',
      }).expect(400);
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: true, payhere_order_id: order_id },
      );
      expect(
        await row('subscription', { payhere_sub_id: 'S2' }),
      ).toBeUndefined();
    });
  });

  describe('re-sent and mislabelled notifications', () => {
    it('a resent SUCCESS does not re-activate a cancelled plan', async () => {
      const { order_id } = await newOrder();
      const paid = { order_id, payment_id: 'P1', subscription_id: 'S1' };
      await notify(paid).expect(200);
      const auth = { Authorization: `Bearer ${ctx.tokenFor(USER)}` };
      await http().post('/subscription/cancel').set(auth).expect(201);

      await notify(paid).expect(200); // PayHere resends the old success
      expect(await row('subscription', { payhere_sub_id: 'S1' })).toMatchObject(
        { is_active: false },
      );
      await http()
        .post('/subscription/payhere-link')
        .set(auth)
        .send({ package_id: PACKAGE_WEEKLY })
        .expect(201);
    });

    it('logs the payment under its real owner, not custom_1', async () => {
      const log = jest.spyOn(
        ctx.app.get(TelegramLoggerService),
        'logNewTransaction',
      );
      const { order_id } = await newOrder();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        custom_1: OTHER_USER,
      }).expect(200);
      expect(log).toHaveBeenCalledWith(
        'P1',
        expect.anything(),
        USER,
        'SUCCESS',
        false, // not a one-time buy
      );
      log.mockRestore();
    });
  });

  describe('later notifications', () => {
    let order_id: string;
    beforeEach(async () => {
      ({ order_id } = await newOrder());
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
    });

    it('a renewal (same order, new payment_id) adds a transaction', async () => {
      await notify({
        order_id,
        payment_id: 'P2',
        subscription_id: 'S1',
        message_type: 'RECURRING_INSTALLMENT_SUCCESS',
      }).expect(200);
      expect(
        await ctx
          .knex('transaction')
          .where({ payhere_sub_id: 'S1', status: 'SUCCESS' })
          .count('* as c')
          .first(),
      ).toEqual({ c: '2' });
    });

    it('a duplicate SUCCESS is idempotent', async () => {
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      expect(await ctx.knex('transaction').count('* as c').first()).toEqual({
        c: '1',
      });
    });

    it('a late PENDING does not downgrade SUCCESS', async () => {
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        status_code: '0',
      }).expect(200);
      expect(await row('transaction', { payhere_pay_id: 'P1' })).toMatchObject({
        status: 'SUCCESS',
      });
    });

    it('SUCCESS can become CHARGEBACK, which is final', async () => {
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        status_code: '-3',
      }).expect(200);
      expect(await row('transaction', { payhere_pay_id: 'P1' })).toMatchObject({
        status: 'CHARGEBACK',
      });
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
        status_code: '2',
      }).expect(200);
      expect(await row('transaction', { payhere_pay_id: 'P1' })).toMatchObject({
        status: 'CHARGEBACK',
      });
    });

    // USER already has an active plan here (a 2nd link would be a 409), so
    // the second checkout is inserted directly.
    const insertOrder = (id: string) =>
      ctx
        .knex('payhere_order')
        .insert({ order_id: id, user_id: USER, package_id: PACKAGE_WEEKLY });

    it('rejects a different order_id for an existing subscription', async () => {
      await insertOrder('order-2');
      await notify({
        order_id: 'order-2',
        payment_id: 'P9',
        subscription_id: 'S1',
      }).expect(400);
    });

    it('rejects a payment_id that belongs to another subscription', async () => {
      await insertOrder('order-2');
      await notify({
        order_id: 'order-2',
        payment_id: 'P1',
        subscription_id: 'S2',
      }).expect(400);
    });

    it.each([
      ['RECURRING_STOPPED', '-1', '-2'],
      ['RECURRING_COMPLETE', '1', '2'],
    ])(
      '%s deactivates the subscription',
      async (message_type, item_rec_status, status_code) => {
        await notify({
          order_id,
          payment_id: 'P5',
          subscription_id: 'S1',
          message_type,
          item_rec_status,
          status_code,
        }).expect(200);
        expect(
          await row('subscription', { payhere_sub_id: 'S1' }),
        ).toMatchObject({ is_active: false });
      },
    );
  });

  describe('price API outage', () => {
    it('stores SUCCESS without sats, then the backfill cron prices it', async () => {
      const { order_id } = await newOrder();
      const price = ctx.app.get(
        (await import('../src/modules/bitcoin-price/bitcoin-price.service'))
          .BitcoinPriceService,
      );
      const spy = jest
        .spyOn(price, 'calculateSatoshis')
        .mockResolvedValueOnce(null);

      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      expect(await row('transaction', { payhere_pay_id: 'P1' })).toMatchObject({
        status: 'SUCCESS',
        satoshis_purchased: null,
      });

      spy.mockRestore();
      const { TransactionService } = await import(
        '../src/modules/transaction/transaction.service'
      );
      await ctx.app.get(TransactionService).backfillMissingBitcoinData();
      expect(
        Number(
          (await row('transaction', { payhere_pay_id: 'P1' }))
            .satoshis_purchased,
        ),
      ).toBe(sats(980));
    });

    it('prices the payment from the rate log when the live price is down', async () => {
      const { order_id } = await newOrder();
      const { BitcoinPriceService } = await import(
        '../src/modules/bitcoin-price/bitcoin-price.service'
      );
      const price = ctx.app.get(BitcoinPriceService);
      // The cron logged a rate a minute ago: 64,000 × 330 = 21,120,000
      await price.recordExchangeRate();
      const loggedAt = new Date(Date.now() - 60_000);
      await ctx.knex('exchange_rate_log').update({
        btc_usd: 64_000,
        btc_lkr: 21_120_000,
        created_at: loggedAt,
      });

      const spy = jest.spyOn(price, 'getBtcUsd').mockResolvedValue(null);
      try {
        await notify({
          order_id,
          payment_id: 'P1',
          subscription_id: 'S1',
        }).expect(200);
      } finally {
        spy.mockResolvedValue(BTC_USD);
      }
      const tx = await row('transaction', { payhere_pay_id: 'P1' });
      expect(Number(tx.btc_price_at_purchase)).toBe(21_120_000);
      // 980 LKR net / 21,120,000
      expect(Number(tx.satoshis_purchased)).toBe(4640);
      // The row shows it wasn't a live price: its price timestamp is the
      // logged rate's (a minute before the payment), not the payment's
      expect(new Date(tx.coingecko_timestamp).getTime()).toBe(
        loggedAt.getTime(),
      );
      expect(new Date(tx.created_at).getTime()).toBeGreaterThan(
        loggedAt.getTime() + 30_000,
      );
    });

    it('a live price is stamped with the time of the payment', async () => {
      const { order_id } = await newOrder();
      const before = Date.now();
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      const tx = await row('transaction', { payhere_pay_id: 'P1' });
      expect(new Date(tx.coingecko_timestamp).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
    });

    it('keeps one active rate, and a deactivated rate is not used', async () => {
      const { order_id } = await newOrder();
      const { BitcoinPriceService } = await import(
        '../src/modules/bitcoin-price/bitcoin-price.service'
      );
      const price = ctx.app.get(BitcoinPriceService);
      await price.recordExchangeRate();
      // Another instance's tick in the same minute: the claim is taken, so
      // nothing is recorded
      await price.recordExchangeRate();
      expect(await ctx.knex('exchange_rate_log').select('id')).toHaveLength(1);
      // Release the once-a-minute claim
      const { RedisService } = await import(
        '../src/modules/redis/redis.service'
      );
      await ctx.app.get(RedisService).del(CacheKeys.bitcoin.rateLogClaim());
      await price.recordExchangeRate();
      const rows = await ctx
        .knex('exchange_rate_log')
        .select('id', 'is_active')
        .orderBy('id');
      expect(rows.map((r: { is_active: boolean }) => r.is_active)).toEqual([
        false,
        true,
      ]);

      // A human takes the rate out of use
      await ctx.knex('exchange_rate_log').update({ is_active: false });
      const spy = jest.spyOn(price, 'getBtcUsd').mockResolvedValue(null);
      try {
        await notify({
          order_id,
          payment_id: 'P1',
          subscription_id: 'S1',
        }).expect(200);
      } finally {
        spy.mockResolvedValue(BTC_USD);
      }
      expect(await row('transaction', { payhere_pay_id: 'P1' })).toMatchObject({
        status: 'SUCCESS',
        satoshis_purchased: null,
      });
    });

    it('a logged rate that is too old is not used', async () => {
      const { order_id } = await newOrder();
      const { BitcoinPriceService } = await import(
        '../src/modules/bitcoin-price/bitcoin-price.service'
      );
      const price = ctx.app.get(BitcoinPriceService);
      await price.recordExchangeRate();
      await ctx
        .knex('exchange_rate_log')
        .update({ created_at: new Date(Date.now() - 6 * 60_000) });

      const spy = jest.spyOn(price, 'getBtcUsd').mockResolvedValue(null);
      try {
        await notify({
          order_id,
          payment_id: 'P1',
          subscription_id: 'S1',
        }).expect(200);
      } finally {
        spy.mockResolvedValue(BTC_USD);
      }
      expect(await row('transaction', { payhere_pay_id: 'P1' })).toMatchObject({
        status: 'SUCCESS',
        satoshis_purchased: null,
      });
    });

    it('does not auto-price old payments; alerts about them instead', async () => {
      const { order_id } = await newOrder();
      const price = ctx.app.get(
        (await import('../src/modules/bitcoin-price/bitcoin-price.service'))
          .BitcoinPriceService,
      );
      jest.spyOn(price, 'calculateSatoshis').mockResolvedValueOnce(null);
      await notify({
        order_id,
        payment_id: 'P1',
        subscription_id: 'S1',
      }).expect(200);
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ created_at: new Date(Date.now() - 25 * 60 * 60 * 1000) });

      const service = ctx.app.get(TransactionService);
      await service.backfillMissingBitcoinData();
      expect(await row('transaction', { payhere_pay_id: 'P1' })).toMatchObject({
        satoshis_purchased: null,
      });

      const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
      await service.alertStaleUnpricedPayments();
      expect(alert).toHaveBeenCalledWith(
        'Backfill',
        expect.stringContaining('P1'),
      );
      alert.mockRestore();
    });
  });
});
