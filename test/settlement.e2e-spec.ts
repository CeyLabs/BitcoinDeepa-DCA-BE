import * as request from 'supertest';
import { AxiosError } from 'axios';
import {
  createTestApp,
  resetData,
  payhereNotification,
  sats,
  TestContext,
  USER,
  PACKAGE_WEEKLY,
} from './support/test-app';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { TelegramLoggerService } from '../src/modules/telegram-logger/telegram-logger.service';
import { TransactionService } from '../src/modules/transaction/transaction.service';

describe('Settlement (e2e)', () => {
  let ctx: TestContext;
  let settlement: SettlementService;
  let orderId: string;
  const tx = () =>
    ctx.knex('transaction').where({ payhere_pay_id: 'P1' }).first();
  /** PayHere reports a chargeback on P1 */
  const chargeback = () =>
    request(ctx.app.getHttpServer())
      .post('/transaction/payhere-webhook')
      .type('form')
      .send(
        payhereNotification({
          order_id: orderId,
          payment_id: 'P1',
          subscription_id: 'S1',
          status_code: '-3',
        }),
      )
      .expect(200);

  beforeAll(async () => {
    ctx = await createTestApp();
    settlement = ctx.app.get(SettlementService);
  });
  afterAll(() => ctx?.close());

  beforeEach(async () => {
    await resetData(ctx);
    // the lookup-failure alert throttle lives on the (shared) service
    (
      settlement as unknown as { lastLookupFailureAlertAt: number }
    ).lastLookupFailureAlertAt = 0;
    const res = await request(ctx.app.getHttpServer())
      .post('/subscription/payhere-link')
      .set('Authorization', `Bearer ${ctx.tokenFor(USER)}`)
      .send({ package_id: PACKAGE_WEEKLY })
      .expect(201);
    orderId = new URL(res.body.link as string).searchParams.get('order_id')!;
    await request(ctx.app.getHttpServer())
      .post('/transaction/payhere-webhook')
      .type('form')
      .send(
        payhereNotification({
          order_id: orderId,
          payment_id: 'P1',
          subscription_id: 'S1',
        }),
      )
      .expect(200);
  });

  it('sends the purchased sats to the user and marks the payment settled', async () => {
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    const [amount, to, memo] = ctx.bitcoinDeepa.transferFunds.mock.calls[0];
    expect(Number(amount)).toBe(sats(980));
    expect(to).toBe(USER);
    // the idempotency key on the bot API: the same on every attempt
    expect(memo).toBe('DCA purchase (Ref: P1)');
    expect(await tx()).toMatchObject({ settled: true, retry_count: 1 });

    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1); // never twice
  });

  it('settles a plan charge saved without an owner once the owner is filled in', async () => {
    // e.g. written by the previous build during a deploy
    await ctx.knex('transaction').where({ payhere_pay_id: 'P1' }).update({
      user_id: null,
    });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();

    await ctx.app.get(TransactionService).fillMissingTransactionOwners();
    expect(await tx()).toMatchObject({ user_id: USER });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    expect(await tx()).toMatchObject({ settled: true });
  });

  it('treats "already completed" as settled', async () => {
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      already_completed: true,
    });
    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({ settled: true });
  });

  it('a failed transfer waits for its backoff before retrying', async () => {
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      message: 'down',
    });
    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({ settled: false, retry_count: 1 });

    await settlement.retryUnsettledTransactions(); // still inside 2^1 minutes
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);

    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ last_retry_at: new Date(Date.now() - 3 * 60_000) });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(2);
    expect(await tx()).toMatchObject({ settled: true, retry_count: 2 });
  });

  it('stops retrying when the outcome is unknown (timeout) to avoid paying twice', async () => {
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      outcome_unknown: true,
      message: 'timeout',
    });
    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({ settled: false, retry_count: 5 });

    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ last_retry_at: new Date(0) });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
  });

  it('alerts and gives up after the 5th failed attempt', async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ retry_count: 4, last_retry_at: new Date(0) });
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      message: 'down',
    });

    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({ settled: false, retry_count: 5 });
    expect(alert).toHaveBeenCalledWith(
      'Settlement',
      expect.stringContaining('permanently failed after 5 attempts'),
    );

    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ last_retry_at: new Date(0) });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  it('a stale snapshot (row already claimed by another run) does not transfer', async () => {
    // Simulates two instances that both loaded the row at retry_count 0;
    // the other one claimed it first.
    const [row] = await ctx
      .knex('transaction as t')
      .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
      .select(
        't.payhere_pay_id',
        't.payhere_sub_id',
        't.satoshis_purchased',
        't.retry_count',
        's.user_id as telegram_id',
      )
      .where('t.payhere_pay_id', 'P1');
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ retry_count: 1, last_retry_at: new Date() });

    await (
      settlement as unknown as {
        tryTransactionSettlement: (t: typeof row) => Promise<void>;
      }
    ).tryTransactionSettlement(row);
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
  });

  it('an admin can re-enable one checked payment, not all of them', async () => {
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      outcome_unknown: true,
      message: 'timeout',
    });
    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({ retry_count: 5 });

    const reset = (id: string) =>
      request(ctx.app.getHttpServer())
        .post(`/transaction/reset-retry-count/${id}`)
        .set('x-admin-key', 'test-admin-key');
    await reset('P-other').expect(404);
    expect(await tx()).toMatchObject({ retry_count: 5 });

    await reset('P1').expect(201);
    expect(await tx()).toMatchObject({ retry_count: 0, last_retry_at: null });
    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({ settled: true });

    await reset('P1').expect(404); // settled payments can't be reset
  });

  it("doesn't pay when PayHere's amount differs from the recorded one", async () => {
    ctx.payHerePayments.mockResolvedValueOnce([
      { payment_id: 'P1', status: 'RECEIVED', amount: '1.00', order_id: null },
    ]);
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
    expect(await tx()).toMatchObject({ settled: false, retry_count: 1 });
  });

  it('pays on id and status when PayHere lists no amount, and says so (daily)', async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    ctx.payHerePayments.mockResolvedValue([
      { payment_id: 'P1', status: 'RECEIVED', amount: null, order_id: null },
    ]);
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    const missing = () =>
      alert.mock.calls.filter(([, text]) =>
        String(text).includes('amount check is not running'),
      );
    expect(missing()).toHaveLength(1);

    // a second such payment the same day: paid, no second alert
    await ctx.knex('transaction').where({ payhere_pay_id: 'P1' }).update({
      settled: false,
      retry_count: 0,
      last_retry_at: null,
    });
    await settlement.retryUnsettledTransactions();
    expect(missing()).toHaveLength(1);
    alert.mockRestore();
  });

  it('pays only payment ids PayHere confirms (stops replayed notifications)', async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    ctx.payHerePayments.mockResolvedValueOnce([]); // PayHere never took P1
    await settlement.retryUnsettledTransactions();
    expect(ctx.payHerePayments).toHaveBeenCalledWith('S1');
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
    expect(await tx()).toMatchObject({ settled: false, retry_count: 1 });

    // still unknown on the last attempt: give up and alert
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ retry_count: 4, last_retry_at: new Date(0) });
    ctx.payHerePayments.mockResolvedValueOnce([
      {
        payment_id: 'P1',
        status: 'CHARGEBACK',
        amount: '1000',
        order_id: null,
      },
    ]);
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      'Settlement',
      expect.stringContaining('Possibly a forged/replayed notification'),
    );
    alert.mockRestore();
  });

  it('a PayHere API outage delays settlement without using up attempts', async () => {
    // far more failures than the 5-attempt budget
    for (let i = 0; i < 7; i++) {
      ctx.payHerePayments.mockRejectedValueOnce(new Error('PayHere 503'));
      await settlement.retryUnsettledTransactions();
      expect(await tx()).toMatchObject({ settled: false, retry_count: 0 });
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ last_retry_at: new Date(0) });
    }
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();

    // PayHere is back: paid normally
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    expect(await tx()).toMatchObject({ settled: true });
  });

  it('alerts at once when PayHere rejects our credentials (401/403)', async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    ctx.payHerePayments.mockRejectedValueOnce(
      new AxiosError('Forbidden', '403', undefined, undefined, {
        status: 403,
      } as never),
    );
    await settlement.retryUnsettledTransactions();
    expect(alert).toHaveBeenCalledWith(
      'Settlement',
      expect.stringContaining('PayHere rejected our credentials (HTTP 403)'),
    );
    alert.mockRestore();
  });

  it('alerts (at most hourly) when lookups keep failing for 30 min', async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    const failOnce = async () => {
      ctx.payHerePayments.mockRejectedValueOnce(new Error('PayHere 503'));
      await settlement.retryUnsettledTransactions();
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ last_retry_at: new Date(0) });
    };

    await failOnce(); // fresh payment: just a delay, no alert
    expect(alert).not.toHaveBeenCalled();

    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ created_at: new Date(Date.now() - 31 * 60_000) });
    await failOnce();
    await failOnce();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      'Settlement',
      expect.stringContaining('Payouts are paused'),
    );
    alert.mockRestore();
  });

  it('a failed PayHere lookup still waits for backoff before retrying', async () => {
    ctx.payHerePayments.mockRejectedValueOnce(new Error('PayHere 503'));
    await settlement.retryUnsettledTransactions();
    await settlement.retryUnsettledTransactions(); // inside the backoff window
    expect(ctx.payHerePayments).toHaveBeenCalledTimes(1);
  });

  it('never settles a payment that is not SUCCESS', async () => {
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ status: 'CHARGEBACK' });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
  });

  it("doesn't settle when a chargeback lands after the claim, before the transfer", async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    // The claim is committed; the chargeback arrives during the PayHere lookup
    ctx.payHerePayments.mockImplementationOnce(async () => {
      await chargeback();
      return [
        {
          payment_id: 'P1',
          status: 'RECEIVED',
          amount: '1000.00',
          order_id: null,
        },
      ];
    });

    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
    expect(await tx()).toMatchObject({ status: 'CHARGEBACK', settled: false });
    // ...so what the chargeback alert promised holds
    expect(alert).toHaveBeenCalledWith(
      'PayHere webhook',
      expect.stringContaining('It will not be settled'),
    );
    alert.mockRestore();
  });

  it('says so when a chargeback lands during the transfer itself', async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    ctx.bitcoinDeepa.transferFunds.mockImplementationOnce(async () => {
      await chargeback();
      return { success: true };
    });

    await settlement.retryUnsettledTransactions();
    // The sats went out: the record says so, and a human is told
    expect(await tx()).toMatchObject({ status: 'CHARGEBACK', settled: true });
    expect(alert).toHaveBeenCalledWith(
      'Settlement',
      expect.stringContaining(
        `arrived while it was being settled: ${sats(980)} sats were sent`,
      ),
    );
    alert.mockRestore();
  });

  it('does nothing when BitcoinDeepa is not configured', async () => {
    ctx.bitcoinDeepa.isConfigured.mockReturnValueOnce(false);
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
  });
});
