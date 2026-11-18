import * as request from 'supertest';
import { ADMIN_ORIGIN, signInAdmin } from './support/admin-session';
import {
  createTestApp,
  OTHER_USER,
  PACKAGE_MONTHLY,
  PACKAGE_WEEKLY,
  resetData,
  TestContext,
  USER,
} from './support/test-app';

const ago = (ms: number) => new Date(Date.now() - ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('Admin analytics (e2e)', () => {
  let ctx: TestContext;
  let cookies: string[];
  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string) =>
    http().get(path).set('Origin', ADMIN_ORIGIN).set('Cookie', cookies);

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetData(ctx);
    cookies = await signInAdmin(ctx);

    await ctx.knex('subscription').insert([
      {
        payhere_sub_id: 'S1',
        user_id: USER,
        package_id: PACKAGE_WEEKLY,
        is_active: true,
      },
      {
        payhere_sub_id: 'S2',
        user_id: OTHER_USER,
        package_id: PACKAGE_MONTHLY,
        is_active: false,
      },
    ]);
    const tx = (
      id: string,
      sub: string,
      status: string,
      gross: number,
      sats: number | null,
      created_at: Date,
    ) => ({
      payhere_pay_id: id,
      payhere_sub_id: sub,
      status,
      gross_amount: gross,
      net_amount: gross * 0.98,
      bitcoindeepa_fee_amount: gross * 0.01,
      satoshis_purchased: sats,
      created_at,
    });
    await ctx
      .knex('transaction')
      .insert([
        tx('T1', 'S1', 'SUCCESS', 1000, 5000, ago(1 * MIN)),
        tx('T3', 'S1', 'FAILED', 1000, null, ago(2 * MIN)),
        tx('T4', 'S1', 'CHARGEBACK', 1000, 5000, ago(3 * MIN)),
        tx('T2', 'S2', 'SUCCESS', 3000, 15000, ago(40 * DAY)),
      ]);
  });

  it('needs an admin session', async () => {
    await http().get('/admin/analytics/summary').expect(401);
  });

  it('summarises users, subscriptions and successful payments', async () => {
    const { body } = await get('/admin/analytics/summary').expect(200);
    expect(body).toEqual({
      users: { total: 2, kycApproved: 1, newLast30Days: 2 },
      subscriptions: { active: 1, total: 2 },
      payments: {
        successful: 2,
        grossLkr: 4000,
        netLkr: 3920,
        bitcoindeepaFeesLkr: 40,
        satoshis: 20000,
        grossLkrLast30Days: 1000,
      },
    });
  });

  it('returns a zero-filled daily series', async () => {
    const { body } = await get('/admin/analytics/daily?days=7').expect(200);
    expect(body).toHaveLength(7);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo',
    }).format(new Date());
    expect(body[6].date).toBe(today);
    const total = (key: string) =>
      (body as Record<string, number>[]).reduce((sum, d) => sum + d[key], 0);
    expect(total('grossLkr')).toBe(1000);
    expect(total('payments')).toBe(1);
    expect(total('newUsers')).toBe(2);

    await get('/admin/analytics/daily?days=10').expect(400);
  });
});
