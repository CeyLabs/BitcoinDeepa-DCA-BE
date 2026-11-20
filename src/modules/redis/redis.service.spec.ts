import { RedisService } from './redis.service';

describe('RedisService', () => {
  describe('without Redis configured', () => {
    const env = { url: process.env.REDIS_URL, host: process.env.REDIS_HOST };
    let service: RedisService;

    beforeEach(async () => {
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
      service = new RedisService();
      await service.onModuleInit();
    });
    afterAll(() => {
      process.env.REDIS_URL = env.url;
      process.env.REDIS_HOST = env.host;
    });

    it('behaves as a permanent cache miss', async () => {
      await service.set('k', { a: 1 });
      await expect(service.get('k')).resolves.toBeNull();
      await expect(service.delByPattern('k*')).resolves.toBe(0);
      await expect(service.ping()).resolves.toBe(true);
    });

    it('getOrSet always calls the loader', async () => {
      const loader = jest.fn().mockResolvedValue({ v: 1 });
      await service.getOrSet('k', 60, loader);
      await service.getOrSet('k', 60, loader);
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  describe('with a Redis client', () => {
    function withFakeRedis() {
      const store = new Map<string, string>();
      const fake = {
        get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
        set: jest.fn((k: string, v: string) => {
          store.set(k, v);
          return Promise.resolve('OK');
        }),
        del: jest.fn((...keys: string[]) =>
          Promise.resolve(keys.filter((k) => store.delete(k)).length),
        ),
        scan: jest.fn((_cursor: string, _m: string, pattern: string) => {
          const re = new RegExp('^' + pattern.split('*').join('.*') + '$');
          return Promise.resolve([
            '0',
            [...store.keys()].filter((k) => re.test(k)),
          ]);
        }),
      };
      const service = new RedisService();
      (service as unknown as { redis: unknown }).redis = fake;
      return { service, fake, store };
    }

    it('round-trips JSON with a TTL', async () => {
      const { service, fake } = withFakeRedis();
      await service.set('k', { a: 1 }, { ttl: 30 });
      expect(fake.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 30);
      await expect(service.get('k')).resolves.toEqual({ a: 1 });
    });

    it('getOrSet caches non-null results only', async () => {
      const { service } = withFakeRedis();
      const loader = jest.fn().mockResolvedValue({ v: 1 });
      await service.getOrSet('k', 60, loader);
      await expect(service.getOrSet('k', 60, loader)).resolves.toEqual({
        v: 1,
      });
      expect(loader).toHaveBeenCalledTimes(1);

      const nullLoader = jest.fn().mockResolvedValue(null);
      await service.getOrSet('n', 60, nullLoader);
      await service.getOrSet('n', 60, nullLoader);
      expect(nullLoader).toHaveBeenCalledTimes(2);
    });

    it('delByPattern deletes only matching keys', async () => {
      const { service, store } = withFakeRedis();
      store.set('dca:transactions:user:1:page:1', '1');
      store.set('dca:transactions:user:1:page:2', '1');
      store.set('dca:transactions:user:2:page:1', '1');
      await expect(
        service.delByPattern('dca:transactions:user:1:*'),
      ).resolves.toBe(2);
      expect([...store.keys()]).toEqual(['dca:transactions:user:2:page:1']);
    });

    it('never throws when Redis errors', async () => {
      const { service, fake } = withFakeRedis();
      fake.get.mockRejectedValue(new Error('down'));
      await expect(service.get('k')).resolves.toBeNull();
    });
  });
});
