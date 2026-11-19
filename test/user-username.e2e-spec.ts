import * as request from 'supertest';
import {
  createTestApp,
  resetData,
  TestContext,
  USER,
  OTHER_USER,
} from './support/test-app';

describe('Usernames: claim, availability, send lookup (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const auth = (userId = USER) => ({
    Authorization: `Bearer ${ctx.tokenFor(userId)}`,
  });
  const claim = (username: unknown, userId = USER) =>
    http().post('/user/username').set(auth(userId)).send({ username });
  const availability = (username: string) =>
    http()
      .get('/user/username/availability')
      .query({ username })
      .set(auth())
      .expect(200);

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(async () => {
    await resetData(ctx);
    ctx.p2pBot.request.mockReset();
  });

  it('claims once (normalized), shows it on /user/me, and never changes', async () => {
    expect((await http().get('/user/me').set(auth())).body.username).toBeNull();

    const res = await claim(' @Nimal_7 ').expect(201);
    expect(res.body.username).toBe('nimal_7');
    expect((await http().get('/user/me').set(auth())).body.username).toBe(
      'nimal_7',
    );

    const again = await claim('another').expect(409);
    expect(again.body.message).toBe('You already have the username @nimal_7');
    expect((await http().get('/user/me').set(auth())).body.username).toBe(
      'nimal_7',
    );
  });

  it('refuses taken, reserved and badly formed names', async () => {
    await claim('nimal').expect(201);
    expect((await claim('NIMAL', OTHER_USER).expect(409)).body.message).toBe(
      'This username is taken',
    );
    expect(
      (await claim('bitcoindeepa', OTHER_USER).expect(409)).body.message,
    ).toBe('This username is reserved');
    for (const bad of ['ab', '1abc', 'has space', 'a'.repeat(21), 42]) {
      await claim(bad, OTHER_USER).expect(400);
    }
    await http().post('/user/username').send({ username: 'abc' }).expect(401);
  });

  it('answers availability with the reason', async () => {
    await claim('nimal').expect(201);
    expect((await availability('kasun')).body).toEqual({
      username: 'kasun',
      available: true,
      reason: null,
    });
    expect((await availability('@Nimal')).body).toMatchObject({
      username: 'nimal',
      available: false,
      reason: 'This username is taken',
    });
    expect((await availability('admin')).body.reason).toBe(
      'This username is reserved',
    );
    expect((await availability('x')).body.available).toBe(false);
  });

  it('resolves a recipient from our DB, never the bot', async () => {
    await claim('nimal', OTHER_USER).expect(201);
    await ctx.knex('user').where({ id: OTHER_USER }).update({
      kyc_full_name: 'Nimal Silva Fernando',
      avatar_seed: 'seed1',
    });

    const found = await http()
      .post('/p2p/resolve')
      .set(auth())
      .send({ to: '@NIMAL' })
      .expect(200);
    expect(found.body).toEqual({
      telegram_id: Number(OTHER_USER),
      username: 'nimal',
      name: 'Nimal S.',
      avatar_seed: 'seed1',
    });

    const missing = await http()
      .post('/p2p/resolve')
      .set(auth())
      .send({ to: 'nobody' })
      .expect(404);
    expect(missing.body.code).toBe('recipient_not_found');

    await claim('me_myself').expect(201);
    const self = await http()
      .post('/p2p/resolve')
      .set(auth())
      .send({ to: 'me_myself' })
      .expect(400);
    expect(self.body.code).toBe('cannot_send_to_self');
    expect(ctx.p2pBot.request).not.toHaveBeenCalled();
  });

  it('labels bot-history rows with our usernames', async () => {
    await claim('nimal', OTHER_USER).expect(201);
    const row = (id: number, direction: string, from: string, to: string) => ({
      id,
      time: '2026-11-19T10:00:00Z',
      direction,
      from_id: Number(from),
      to_id: Number(to),
      type: 'send',
      amount: 1000,
      amount_lkr: '300',
      success: true,
    });
    ctx.bitcoinDeepa.getUserTransactions.mockResolvedValueOnce({
      success: true,
      count: 3,
      limit: 50,
      offset: 0,
      transactions: [
        row(1, 'outgoing', USER, OTHER_USER),
        row(2, 'incoming', OTHER_USER, USER),
        row(3, 'outgoing', USER, '999'),
      ],
    });
    const history = await http()
      .get('/transaction/bot-history?limit=50&offset=0')
      .set(auth())
      .expect(200);
    expect(
      history.body.transactions.map(
        (t: { counterparty_username: string | null }) =>
          t.counterparty_username,
      ),
    ).toEqual(['nimal', 'nimal', null]);
  });
});
