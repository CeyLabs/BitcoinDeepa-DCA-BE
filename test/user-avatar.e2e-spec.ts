import * as request from 'supertest';
import {
  createTestApp,
  resetData,
  TestContext,
  USER,
  OTHER_USER,
} from './support/test-app';

describe('User avatar (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const auth = (userId = USER) => ({
    Authorization: `Bearer ${ctx.tokenFor(userId)}`,
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(() => resetData(ctx));

  it('starts without a seed, saves one and returns it from /user/me', async () => {
    const before = await http().get('/user/me').set(auth()).expect(200);
    expect(before.body.avatar_seed).toBeNull();

    const saved = await http()
      .patch('/user/avatar')
      .set(auth())
      .send({ seed: 'ez9p56yg' })
      .expect(200);
    expect(saved.body.avatar_seed).toBe('ez9p56yg');
    expect(saved.body.is_profile_complete).toBeDefined();

    const after = await http().get('/user/me').set(auth()).expect(200);
    expect(after.body.avatar_seed).toBe('ez9p56yg');

    // Only the caller's own row changes
    const other = await http()
      .get('/user/me')
      .set(auth(OTHER_USER))
      .expect(200);
    expect(other.body.avatar_seed).toBeNull();
  });

  it('refuses a bad seed and needs a session', async () => {
    for (const seed of ['', 'has space', 'a'.repeat(65), '<svg>', 42]) {
      await http().patch('/user/avatar').set(auth()).send({ seed }).expect(400);
    }
    await http().patch('/user/avatar').send({ seed: 'abc' }).expect(401);
  });
});
