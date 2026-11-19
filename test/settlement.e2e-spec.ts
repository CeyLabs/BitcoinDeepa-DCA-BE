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
import { RedisService } from '../src/modules/redis/redis.service';

/** The deposit callback's per-instance fallback throttle lives on a shared service */
function resetDepositThrottle(): void {
  ctx.app.get<TransactionService, { lastDepositResetAt: number }>(
    TransactionService,
  ).lastDepositResetAt = 0;
}
let ctx: TestContext;

describe('Settlement (e2e)', () => {
  let settlement: SettlementService;
  const tx = () =>
    ctx.knex('transaction').where({ payhere_pay_id: 'P1' }).first();

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
    // the deposit-callback fallback throttle also lives on a shared service
    resetDepositThrottle();
    const res = await request(ctx.app.getHttpServer())
      .post('/subscription/payhere-link')
      .set('Authorization', `Bearer ${ctx.tokenFor(USER)}`)
      .send({ package_id: PACKAGE_WEEKLY })
      .expect(201);
    const order_id = new URL(res.body.link as string).searchParams.get(
      'order_id',
    )!;
    await request(ctx.app.getHttpServer())
      .post('/transaction/payhere-webhook')
      .type('form')
      .send(
        payhereNotification({
          order_id,
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

  it('retries an unknown outcome (timeout) with the SAME memo after checking the bot history', async () => {
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      outcome_unknown: true,
      failure: 'UNKNOWN',
      message: 'timeout',
    });
    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({
      settled: false,
      retry_count: 1,
      settlement_failure: 'UNKNOWN',
    });

    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ last_retry_at: new Date(0) });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.findTransferByMemo).toHaveBeenCalledWith(
      Number(USER),
      'DCA purchase (Ref: P1)',
    );
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(2);
    const memos = ctx.bitcoinDeepa.transferFunds.mock.calls.map(
      (c) => c[2] as string,
    );
    expect(memos).toEqual(['DCA purchase (Ref: P1)', 'DCA purchase (Ref: P1)']);
    expect(await tx()).toMatchObject({
      settled: true,
      settlement_failure: null,
    });
  });

  it('an unknown outcome found in the bot history is settled without resending', async () => {
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      outcome_unknown: true,
      failure: 'UNKNOWN',
      message: 'timeout',
    });
    await settlement.retryUnsettledTransactions();
    ctx.bitcoinDeepa.findTransferByMemo.mockResolvedValueOnce(true);
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ last_retry_at: new Date(0) });
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    expect(await tx()).toMatchObject({ settled: true });
  });

  describe('sends held for approval in the bot (202)', () => {
    beforeEach(async () => {
      ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
        success: false,
        awaiting_approval_id: 'pending-7',
      });
      await settlement.retryUnsettledTransactions();
    });

    it('stores the bot id, keeps the attempt and does not resend', async () => {
      expect(await tx()).toMatchObject({
        settled: false,
        bot_send_id: 'pending-7',
        retry_count: 0,
      });
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ last_retry_at: new Date(0) });
      await settlement.retryUnsettledTransactions();
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    });

    it('waits while pending, settles once executed', async () => {
      ctx.bitcoinDeepa.getSendStatus.mockResolvedValueOnce({
        status: 'pending',
      });
      await settlement.pollAwaitingApprovals();
      expect(await tx()).toMatchObject({
        settled: false,
        bot_send_id: 'pending-7',
      });

      ctx.bitcoinDeepa.getSendStatus.mockResolvedValueOnce({
        status: 'executed',
      });
      await settlement.pollAwaitingApprovals();
      expect(ctx.bitcoinDeepa.getSendStatus).toHaveBeenCalledWith('pending-7');
      expect(await tx()).toMatchObject({ settled: true, bot_send_id: null });
    });

    it('a stale tick that loaded the row before the 202 does not send it again', async () => {
      // tick A loaded P1 at retry_count 0, then waited on another slow send;
      // meanwhile tick B got the 202 and handed the attempt back
      const stale = {
        payhere_pay_id: 'P1',
        kind: 'RECURRING',
        payhere_sub_id: 'S1',
        payhere_order_id: null,
        satoshis_purchased: sats(980),
        gross_amount: 1000,
        retry_count: 0,
        telegram_id: USER,
        created_at: new Date(),
        settlement_failure: null,
      };
      expect(await tx()).toMatchObject({ retry_count: 0 });
      await (
        settlement as unknown as {
          tryTransactionSettlement: (t: typeof stale) => Promise<void>;
        }
      ).tryTransactionSettlement(stale);
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    });

    it('an id the bot does not know (404) stops as an unknown outcome', async () => {
      const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
      ctx.bitcoinDeepa.getSendStatus.mockResolvedValueOnce('NOT_FOUND');
      await settlement.pollAwaitingApprovals();
      expect(await tx()).toMatchObject({
        settled: false,
        bot_send_id: null,
        settlement_failure: 'UNKNOWN',
        retry_count: 5,
      });
      expect(alert).toHaveBeenCalledWith(
        'Settlement',
        expect.stringContaining("doesn't know send pending-7"),
      );
      alert.mockRestore();
    });

    it('reports (once) an approval still not final after 25h', async () => {
      const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ last_retry_at: new Date(Date.now() - 26 * 60 * 60_000) });
      ctx.bitcoinDeepa.getSendStatus.mockResolvedValue(null); // unreadable
      await settlement.pollAwaitingApprovals();
      await settlement.pollAwaitingApprovals();
      const overdue = alert.mock.calls.filter(([, text]) =>
        String(text).includes('waited over 25h'),
      );
      expect(overdue).toHaveLength(1);
      ctx.bitcoinDeepa.getSendStatus.mockResolvedValue(null);
      alert.mockRestore();
    });

    it('alerts once when two instances see the rejection at the same time', async () => {
      const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
      ctx.bitcoinDeepa.getSendStatus.mockResolvedValue({ status: 'rejected' });
      await Promise.all([
        settlement.pollAwaitingApprovals(),
        settlement.pollAwaitingApprovals(),
      ]);
      const rejected = alert.mock.calls.filter(([, text]) =>
        String(text).includes('was rejected'),
      );
      expect(rejected).toHaveLength(1);
      ctx.bitcoinDeepa.getSendStatus.mockResolvedValue(null);
      alert.mockRestore();
    });

    it.each(['rejected', 'expired'])(
      'stops and alerts when the approval is %s',
      async (status) => {
        const alert = jest.spyOn(
          ctx.app.get(TelegramLoggerService),
          'logAlert',
        );
        ctx.bitcoinDeepa.getSendStatus.mockResolvedValueOnce({ status });
        await settlement.pollAwaitingApprovals();
        expect(await tx()).toMatchObject({
          settled: false,
          bot_send_id: null,
          settlement_failure: 'APPROVAL_REJECTED',
          retry_count: 5,
        });
        expect(alert).toHaveBeenCalledWith(
          'Settlement',
          expect.stringContaining(`was ${status}`),
        );
        alert.mockRestore();
      },
    );
  });

  describe('low DCA-wallet balance and the bot deposit callback', () => {
    const callback = () =>
      request(ctx.app.getHttpServer()).post('/transaction/reset-retry-counts');
    const longAgo = () => new Date(Date.now() - 5 * 60_000);

    beforeEach(async () => {
      ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
        success: false,
        failure: 'LOW_BALANCE',
        message: 'Insufficient balance',
      });
      await settlement.retryUnsettledTransactions();
      // the attempt finished a while ago (not in flight)
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ last_retry_at: longAgo() });
    });

    it('records the reason; the callback retries it at once', async () => {
      expect(await tx()).toMatchObject({
        retry_count: 1,
        settlement_failure: 'LOW_BALANCE',
      });
      const res = await callback().expect(200);
      expect(res.body).toEqual({ reset: 1 });
      expect(await tx()).toMatchObject({
        retry_count: 1, // attempts are not given back
        last_retry_at: null,
        settlement_failure: null,
      });
      await settlement.retryUnsettledTransactions(); // no backoff to wait out
      expect(await tx()).toMatchObject({ settled: true });
    });

    it('gives an exhausted payment exactly one more attempt', async () => {
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ retry_count: 5 });
      await callback().expect(200);
      expect(await tx()).toMatchObject({ retry_count: 4 });
    });

    it('calling it again does nothing until another real attempt fails', async () => {
      await callback().expect(200);
      resetDepositThrottle();
      await ctx.app.get(RedisService).delByPattern('dca:bot-deposit-reset');
      const res = await callback().expect(200);
      expect(res.body).toEqual({ reset: 0 }); // no longer LOW_BALANCE
    });

    it('is throttled: a second call within 30s resets nothing', async () => {
      await callback().expect(200);
      await ctx.knex('transaction').where({ payhere_pay_id: 'P1' }).update({
        settlement_failure: 'LOW_BALANCE',
        retry_count: 1,
        last_retry_at: longAgo(),
      });
      const res = await callback().expect(200);
      expect(res.body).toEqual({ reset: 0 });
      expect(await tx()).toMatchObject({ retry_count: 1 });
    });

    it('skips a payment attempted in the last 2 minutes (its send may be in flight)', async () => {
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ last_retry_at: new Date() });
      const res = await callback().expect(200);
      expect(res.body).toEqual({ reset: 0 });
    });

    it('cannot reset a payment while its send is in flight', async () => {
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update({ last_retry_at: new Date(0) });
      let duringSend: { body: unknown; row: unknown } | undefined;
      ctx.bitcoinDeepa.transferFunds.mockImplementationOnce(async () => {
        // the claim cleared LOW_BALANCE, so the callback can't match it
        const res = await callback().expect(200);
        duringSend = { body: res.body, row: await tx() };
        return { success: true };
      });
      await settlement.retryUnsettledTransactions();
      expect(duringSend).toMatchObject({
        body: { reset: 0 },
        row: { settlement_failure: null, retry_count: 2 },
      });
      expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(2);
      expect(await tx()).toMatchObject({ settled: true });
    });

    it.each([
      ['an unknown outcome', { settlement_failure: 'UNKNOWN' }],
      ['a rejected send', { settlement_failure: 'REJECTED' }],
      ['a held buy', { hold_reason: 'check me' }],
      ['a send awaiting approval', { bot_send_id: 'pending-9' }],
    ])('leaves %s alone', async (_, change) => {
      await ctx
        .knex('transaction')
        .where({ payhere_pay_id: 'P1' })
        .update(change);
      const res = await callback().expect(200);
      expect(res.body).toEqual({ reset: 0 });
      expect(await tx()).toMatchObject({ retry_count: 1 });
    });

    describe('with BITCOINDEEPA_CALLBACK_SECRET set', () => {
      const SECRET = 'callback-secret-0123456789';
      beforeEach(() => {
        process.env.BITCOINDEEPA_CALLBACK_SECRET = SECRET;
      });
      afterEach(() => {
        delete process.env.BITCOINDEEPA_CALLBACK_SECRET;
      });

      it('rejects a call without the right X-Callback-Secret', async () => {
        await callback().expect(401);
        await callback().set('X-Callback-Secret', 'wrong').expect(401);
        expect(await tx()).toMatchObject({ settlement_failure: 'LOW_BALANCE' });
      });

      it('accepts the right secret', async () => {
        const res = await callback()
          .set('X-Callback-Secret', SECRET)
          .expect(200);
        expect(res.body).toEqual({ reset: 1 });
      });
    });
  });

  it('alerts at once (at most hourly) when the bot rejects our signature', async () => {
    const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: false,
      failure: 'AUTH',
      message: 'Invalid signature',
    });
    await settlement.retryUnsettledTransactions();
    expect(await tx()).toMatchObject({ settlement_failure: 'AUTH' });
    expect(alert).toHaveBeenCalledWith(
      'Settlement',
      expect.stringContaining('rejected our signed request'),
    );
    alert.mockRestore();
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
    // retries used up (e.g. a rejected approval)
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P1' })
      .update({ retry_count: 5, last_retry_at: new Date(0) });

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

  it('does nothing when BitcoinDeepa is not configured', async () => {
    ctx.bitcoinDeepa.isConfigured.mockReturnValueOnce(false);
    await settlement.retryUnsettledTransactions();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();
  });
});
