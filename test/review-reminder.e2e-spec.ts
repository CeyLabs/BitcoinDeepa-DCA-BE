import {
  createTestApp,
  resetData,
  TestContext,
  USER,
} from './support/test-app';
import { signInAdmin } from './support/admin-session';
import { asUser, verifiedBankAccount } from './support/bank-account-helpers';
import { ReviewReminderService } from '../src/modules/settlement/review-reminder.service';
import { RedisService } from '../src/modules/redis/redis.service';
import { TelegramLoggerService } from '../src/modules/telegram-logger/telegram-logger.service';

describe('Reminder of what waits for a human (e2e)', () => {
  let ctx: TestContext;
  let reminder: ReviewReminderService;
  let logAlert: jest.SpyInstance;
  const ago = (interval: string) =>
    ctx.knex.raw(`now() - interval '${interval}'`);
  /** Start a new reminder interval */
  const nextInterval = () =>
    ctx.app.get(RedisService).delByPattern('dca:alert:*');
  const reminders = () =>
    (logAlert.mock.calls as [string, string][]).filter(
      ([source]) => source === 'Waiting for review',
    );

  /** A sale parked for a human `age` ago */
  const saleInReview = async (age: string): Promise<string> => {
    const res = await asUser(ctx, USER)
      .post('/sell/quote', { sats: 100_000 })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await ctx
      .knex('sell_order')
      .where({ id })
      .update({
        status: 'NEEDS_REVIEW',
        failure_reason: 'Refund outcome unknown',
        updated_at: ago(age),
      });
    return id;
  };

  const payment = (row: Record<string, unknown>) =>
    ctx.knex('transaction').insert({
      user_id: USER,
      status: 'SUCCESS',
      gross_amount: 1000,
      btc_price_at_purchase: 21_450_000,
      satoshis_purchased: 4568,
      ...row,
    });

  /** A one-time buy held at payment time, `age` ago */
  const heldBuy = async (id: string, age: string) => {
    await ctx.knex('buy_order').insert({
      order_id: `order-${id}`,
      user_id: USER,
      kind: 'ONE_TIME',
      amount: 1000,
      currency: 'LKR',
      expires_at: new Date(),
    });
    await payment({
      payhere_pay_id: id,
      kind: 'ONE_TIME',
      payhere_order_id: `order-${id}`,
      hold_reason: 'paid twice',
      created_at: ago(age),
    });
  };

  /** A payment whose settlement used its last attempt `age` ago */
  const stoppedSettlement = (id: string, age: string) =>
    payment({ payhere_pay_id: id, retry_count: 5, last_retry_at: ago(age) });

  beforeAll(async () => {
    ctx = await createTestApp();
    reminder = ctx.app.get(ReviewReminderService);
    logAlert = jest
      .spyOn(ctx.app.get(TelegramLoggerService), 'logAlert')
      .mockResolvedValue();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetData(ctx);
    await verifiedBankAccount(ctx, USER, await signInAdmin(ctx));
    ctx.bitcoinDeepa.getUserBalance.mockResolvedValue({
      success: true,
      balance: 1_000_000,
    });
    logAlert.mockClear();
  });

  it('says nothing when nothing is waiting', async () => {
    // Ordinary rows: a settled payment, one still being retried
    await payment({ payhere_pay_id: 'P1', settled: true, retry_count: 5 });
    await payment({
      payhere_pay_id: 'P2',
      retry_count: 2,
      last_retry_at: ago('1 hour'),
    });
    await reminder.remind();
    expect(reminders()).toHaveLength(0);
  });

  it('repeats sales in review, held buys and stopped settlements until they are dealt with', async () => {
    const saleId = await saleInReview('1 hour');
    await heldBuy('B1', '1 hour');
    // e.g. the process died during the 5th attempt: nothing alerted then
    await stoppedSettlement('P9', '1 hour');
    // Waiting for approval in the bot: its own cron follows it
    await payment({
      payhere_pay_id: 'P7',
      retry_count: 5,
      last_retry_at: ago('1 hour'),
      bot_send_id: 'pending-7',
    });

    await reminder.remind();
    expect(reminders()).toHaveLength(1);
    const text = reminders()[0][1];
    expect(text).toContain('3 item(s) still waiting for a human');
    expect(text).toContain(
      `${saleId}: 100,000 sats for 21205.50 LKR, #UID${USER} - Refund outcome unknown`,
    );
    expect(text).toContain(`B1: 1000.00 LKR, #UID${USER} - paid twice`);
    expect(text).toContain(`P9: 4,568 sats, #UID${USER}`);

    // Once per interval, however many instances run the cron
    await reminder.remind();
    expect(reminders()).toHaveLength(1);

    // Still open at the next interval: said again
    await nextInterval();
    await reminder.remind();
    expect(reminders()).toHaveLength(2);

    // A human dealt with each of them
    await ctx
      .knex('sell_order')
      .where({ id: saleId })
      .update({ status: 'REFUNDED' });
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'B1' })
      .update({ hold_reason: null });
    await ctx
      .knex('transaction')
      .where({ payhere_pay_id: 'P9' })
      .update({ settled: true });
    await nextInterval();
    await reminder.remind();
    expect(reminders()).toHaveLength(2);
  });

  it('leaves out what was alerted moments ago, and buys older than a week', async () => {
    await saleInReview('5 minutes');
    await stoppedSettlement('P9', '5 minutes');
    await heldBuy('B1', '8 days');
    await stoppedSettlement('P8', '8 days');
    await reminder.remind();
    expect(reminders()).toHaveLength(0);

    // A sale stays until someone changes its status
    const old = await saleInReview('30 days');
    await reminder.remind();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0][1]).toContain(old);
  });

  it('lists a few per group and counts the rest', async () => {
    for (let i = 0; i < 10; i++) {
      await stoppedSettlement(`P${i}`, `${i + 1} hours`);
    }
    await reminder.remind();
    const text = reminders()[0][1];
    expect(text).toContain('10 item(s)');
    expect(text).toContain('- and 2 more');
    // oldest first
    expect(text.indexOf('P9:')).toBeLessThan(text.indexOf('P8:'));
    expect(text).not.toContain('P0:');
  });
});
