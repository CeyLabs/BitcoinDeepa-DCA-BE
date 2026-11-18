import * as request from 'supertest';
import {
  createTestApp,
  OTHER_USER,
  PACKAGE_MONTHLY,
  PACKAGE_WEEKLY,
  resetData,
  TestContext,
  USER,
} from './support/test-app';
import { ADMIN_ORIGIN, signInAdmin } from './support/admin-session';

interface Member {
  id: string;
  name: string;
  kycStatus: string;
  activePlan: string | null;
  totalPaidLkr: number;
  satoshis: number;
}
interface Page {
  items: Member[];
  total: number;
  pageCount: number;
}

describe('Admin members list (e2e)', () => {
  let ctx: TestContext;
  let cookies: string[];
  const list = (query = '') =>
    request(ctx.app.getHttpServer())
      .get(`/admin/members${query}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', cookies);
  const ok = async (query = '') => (await list(query).expect(200)).body as Page;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    // resetData adds USER ("Test User", KYC approved) and OTHER_USER
    // ("Other User", not started), both with test@example.com
    await resetData(ctx);
    cookies = await signInAdmin(ctx);

    // 23 older members M01..M23 (M23 newest of them); odd ones KYC approved
    const base = Date.parse('2026-01-01T00:00:00Z');
    await ctx.knex('user').insert(
      Array.from({ length: 23 }, (_, i) => {
        const n = i + 1;
        return {
          id: String(200000000 + n),
          first_name: 'Member',
          last_name: `M${String(n).padStart(2, '0')}`,
          email: `m${n}@members.test`,
          address: 'x',
          city: 'Kandy',
          country: 'Sri Lanka',
          kyc_status: n % 2 ? 'APPROVED' : 'NOT_STARTED',
          created_at: new Date(base + n * 86_400_000),
        };
      }),
    );

    await ctx.knex('subscription').insert([
      { payhere_sub_id: 'S1', user_id: USER, package_id: PACKAGE_WEEKLY },
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
      sats: number,
      settled = status === 'SUCCESS',
    ) => ({
      payhere_pay_id: id,
      payhere_sub_id: sub,
      status,
      gross_amount: gross,
      satoshis_purchased: sats,
      settled,
    });
    await ctx.knex('transaction').insert([
      tx('T1', 'S1', 'SUCCESS', 1000, 5000),
      tx('T2', 'S1', 'SUCCESS', 3000, 15000),
      tx('T3', 'S1', 'FAILED', 1000, 5000),
      tx('T4', 'S2', 'SUCCESS', 500, 2500),
      // paid, but the sats weren't sent: reported apart
      tx('T5', 'S1', 'SUCCESS', 700, 3500, false),
    ]);
  });

  it('needs an admin session', async () => {
    await request(ctx.app.getHttpServer()).get('/admin/members').expect(401);
  });

  it('pages through every member newest first, without overlap', async () => {
    const pages = await Promise.all(
      [1, 2, 3].map((p) => ok(`?pageSize=10&page=${p}`)),
    );
    expect(pages[0]).toMatchObject({ total: 25, pageCount: 3 });
    expect(pages[2].items).toHaveLength(5);
    const ids = pages.flatMap((p) => p.items.map((m) => m.id));
    expect(new Set(ids).size).toBe(25);
    // the two base members were created just now, M01 is the oldest
    expect(ids.slice(0, 2).sort()).toEqual([USER, OTHER_USER].sort());
    expect(ids[24]).toBe('200000001');
  });

  it('shows plan and successful-payment totals per member', async () => {
    const { items } = await ok('?pageSize=10');
    const user = items.find((m) => m.id === USER);
    const other = items.find((m) => m.id === OTHER_USER);
    expect(user).toMatchObject({
      name: 'Test User',
      kycStatus: 'APPROVED',
      activePlan: 'Shrimp Weekly',
      totalPaidLkr: 4000,
      satoshis: 20000,
      unsettledLkr: 700,
    });
    expect(other).toMatchObject({
      activePlan: null,
      totalPaidLkr: 500,
      satoshis: 2500,
      unsettledLkr: 0,
    });
  });

  it('filters by KYC status and subscription', async () => {
    expect((await ok('?kyc=APPROVED')).total).toBe(13); // USER + 12 odd Ms
    expect((await ok('?subscription=active')).items.map((m) => m.id)).toEqual([
      USER,
    ]);
    expect((await ok('?subscription=none')).total).toBe(24);
  });

  it('searches by id, name, email and phone', async () => {
    expect((await ok(`?q=${USER}`)).items.map((m) => m.id)).toEqual([USER]);
    expect((await ok('?q=other%20us')).total).toBe(1);
    expect((await ok('?q=members.test')).total).toBe(23);
    expect((await ok('?q=0771234567')).total).toBe(2);
    expect((await ok('?q=%25')).total).toBe(0);
  });

  it('rejects invalid parameters', async () => {
    await list('?kyc=DONE').expect(400);
    await list('?subscription=yes').expect(400);
    await list('?pageSize=7').expect(400);
  });
});
