import * as request from 'supertest';
import {
  createTestApp,
  resetData,
  TestContext,
  USER,
  OTHER_USER,
} from './support/test-app';

const now = () => Math.floor(Date.now() / 1000);
/** Raw Mini App initData (unsigned: P2P calls must ignore it) */
const initData = (userId = USER, ageSeconds = 30) =>
  new URLSearchParams({
    query_id: 'q',
    user: JSON.stringify({ id: Number(userId), first_name: 'A' }),
    auth_date: String(now() - ageSeconds),
    hash: 'h',
  }).toString();

const transfer = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'p2p-0123abcd',
  kind: 'internal',
  status,
  amount: 1000,
  to: { telegram_id: Number(OTHER_USER), name: 'Bob' },
  created_at: new Date().toISOString(),
  ...extra,
});

describe('P2P sends (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const auth = (userId = USER) => ({
    Authorization: `Bearer ${ctx.tokenFor(userId)}`,
  });
  const sendBody = {
    to_telegram_id: Number(OTHER_USER),
    amount: 1000,
    memo: 'lunch',
    idempotency_key: 'a1b2c3d4-e5f6',
  };

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(async () => {
    await resetData(ctx);
    ctx.p2pBot.isConfigured.mockReturnValue(true);
    ctx.p2pBot.request.mockReset();
  });
  afterEach(() => {
    delete process.env.P2P_ENABLED;
  });

  it('is on by default, off (503) with P2P_ENABLED=false or no key, and needs a signed-in user', async () => {
    process.env.P2P_ENABLED = 'false';
    await http().get('/p2p/me').set(auth()).expect(503);
    delete process.env.P2P_ENABLED;
    const key = process.env.BITCOINDEEPA_P2P_PRIVATE_KEY_PEM;
    delete process.env.BITCOINDEEPA_P2P_PRIVATE_KEY_PEM;
    try {
      await http().get('/p2p/me').set(auth()).expect(503);
    } finally {
      process.env.BITCOINDEEPA_P2P_PRIVATE_KEY_PEM = key;
    }
    await http().get('/p2p/me').expect(401);
    expect(ctx.p2pBot.request).not.toHaveBeenCalled();
  });

  it('names the session user (X-BDB-User) and passes 202 + the transfer through', async () => {
    ctx.p2pBot.request.mockResolvedValue({
      status: 202,
      body: transfer('awaiting_confirmation', {
        confirm_by: new Date(Date.now() + 600_000).toISOString(),
      }),
    });
    const res = await http()
      .post('/p2p/send')
      .set(auth())
      .send(sendBody)
      .expect(202);
    expect(res.body).toMatchObject({ status: 'awaiting_confirmation' });
    expect(ctx.p2pBot.request).toHaveBeenCalledWith(
      'POST',
      '/api/v1/p2p/send',
      { kind: 'user', telegramId: USER },
      sendBody,
    );
  });

  it('ignores a Telegram header from the app: only the session names the user', async () => {
    ctx.p2pBot.request.mockResolvedValue({
      status: 200,
      body: { telegram_id: Number(USER), balance: 5000, limits: {} },
    });
    await http()
      .get('/p2p/me')
      .set(auth())
      .set('X-Telegram-Init-Data', initData(OTHER_USER))
      .expect(200);
    expect(ctx.p2pBot.request).toHaveBeenCalledWith(
      'GET',
      '/api/v1/p2p/me',
      { kind: 'user', telegramId: USER },
      undefined,
    );
  });

  it('a user the bot has not linked gets 401 relogin_required (log in again)', async () => {
    ctx.p2pBot.request.mockResolvedValue({
      status: 403,
      body: { code: 'login_required', message: 'Log in first.' },
    });
    const res = await http()
      .post('/p2p/send')
      .set(auth())
      .send(sendBody)
      .expect(401);
    expect(res.body.code).toBe('relogin_required');
  });

  it("passes the bot's 4xx through, and maps an unanswered send to 502 outcome_unknown", async () => {
    ctx.p2pBot.request.mockResolvedValueOnce({
      status: 404,
      body: { code: 'recipient_not_found', message: 'No such user.' },
    });
    const notFound = await http()
      .post('/p2p/send')
      .set(auth())
      .send(sendBody)
      .expect(404);
    expect(notFound.body).toEqual({
      code: 'recipient_not_found',
      message: 'No such user.',
    });

    ctx.p2pBot.request.mockRejectedValueOnce(new Error('timeout'));
    const unknown = await http()
      .post('/p2p/send')
      .set(auth())
      .send(sendBody)
      .expect(502);
    expect(unknown.body.code).toBe('outcome_unknown');
  });

  it('validates bodies and ids before calling the bot', async () => {
    const h = auth();
    await http()
      .post('/p2p/send')
      .set(h)
      .send({ ...sendBody, amount: 0 })
      .expect(400);
    await http()
      .post('/p2p/send')
      .set(h)
      .send({ ...sendBody, idempotency_key: 'short' })
      .expect(400);
    await http().post('/p2p/resolve').set(h).send({ to: '' }).expect(400);
    await http().get('/p2p/transfers/not-a-transfer').set(h).expect(400);
    expect(ctx.p2pBot.request).not.toHaveBeenCalled();
  });

  it('never forwards fields beyond the documented ones (the bot rejects unknown fields)', async () => {
    ctx.p2pBot.request.mockResolvedValue({
      status: 200,
      body: transfer('completed'),
    });
    await http()
      .post('/p2p/send')
      .set(auth())
      .send({ ...sendBody, telegram_id: OTHER_USER, extra: 1 })
      .expect(200);
    expect(ctx.p2pBot.request.mock.calls[0][3]).toEqual(sendBody);
  });
});
