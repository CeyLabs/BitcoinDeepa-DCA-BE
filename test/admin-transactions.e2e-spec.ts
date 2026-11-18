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

interface Page {
  items: { id: string; status: string; user: { name: string } | null }[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

describe('Admin transactions list (e2e)', () => {
  let ctx: TestContext;
  let cookies: string[];
  const list = (query = '') =>
    request(ctx.app.getHttpServer())
      .get(`/admin/transactions${query}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', cookies);
  const ok = async (query = '') => (await list(query).expect(200)).body as Page;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetData(ctx);
    cookies = await signInAdmin(ctx);
    await ctx.knex('subscription').insert([
      { payhere_sub_id: 'S1', user_id: USER, package_id: PACKAGE_WEEKLY },
      {
        payhere_sub_id: 'S2',
        user_id: OTHER_USER,
        package_id: PACKAGE_MONTHLY,
      },
    ]);
    // P01..P25, one hour apart: P25 is the newest. Every 5th one FAILED,
    // odd ones belong to OTHER_USER ("Other User").
    const base = Date.parse('2026-03-01T00:00:00Z');
    await ctx.knex('transaction').insert(
      Array.from({ length: 25 }, (_, i) => {
        const n = i + 1;
        return {
          payhere_pay_id: `P${String(n).padStart(2, '0')}`,
          payhere_sub_id: n % 2 ? 'S2' : 'S1',
          status: n % 5 === 0 ? 'FAILED' : 'SUCCESS',
          gross_amount: 1000,
          created_at: new Date(base + n * 3_600_000),
        };
      }),
    );
  });

  it('needs an admin session', async () => {
    await request(ctx.app.getHttpServer())
      .get('/admin/transactions')
      .expect(401);
  });

  it('pages through every transaction newest first, without overlap', async () => {
    const first = await ok('?pageSize=10');
    expect(first).toMatchObject({
      total: 25,
      page: 1,
      pageSize: 10,
      pageCount: 3,
    });
    expect(first.items[0].id).toBe('P25');

    const second = await ok('?pageSize=10&page=2');
    const third = await ok('?pageSize=10&page=3');
    expect(third.items).toHaveLength(5);
    const ids = [...first.items, ...second.items, ...third.items].map(
      (t) => t.id,
    );
    expect(new Set(ids).size).toBe(25);
    expect(ids[24]).toBe('P01');

    const past = await ok('?pageSize=10&page=4');
    expect(past.items).toEqual([]);
    expect(past.total).toBe(25);
  });

  it('filters by status', async () => {
    const failed = await ok('?status=FAILED');
    expect(failed.total).toBe(5);
    expect(failed.items.every((t) => t.status === 'FAILED')).toBe(true);
  });

  it('filters by Sri Lanka calendar day', async () => {
    // P19 = 2026-03-01T19:00Z = 2 March 00:30 in Colombo (UTC+5:30)
    const day1 = await ok('?from=2026-03-01&to=2026-03-01&pageSize=100');
    const day2 = await ok('?from=2026-03-02&pageSize=100');
    expect(day1.items.map((t) => t.id)).not.toContain('P19');
    expect(day2.items.map((t) => t.id)).toContain('P19');
    expect(day1.total + day2.total).toBe(25);
  });

  it('searches by payment id, member id and name', async () => {
    expect((await ok('?q=P07')).items.map((t) => t.id)).toEqual(['P07']);
    expect((await ok(`?q=${USER}`)).total).toBe(12);
    expect((await ok('?q=other%20us')).total).toBe(13);
    // LIKE wildcards are matched literally
    expect((await ok('?q=%25')).total).toBe(0);
  });

  it('rejects invalid parameters', async () => {
    await list('?pageSize=7').expect(400);
    await list('?page=0').expect(400);
    await list('?status=DONE').expect(400);
    await list('?from=03-01-2026').expect(400);
  });
});
