import { PackageService } from './package.service';

/** getOrSet that returns a cached value without calling the loader */
const cached = (value: unknown) => ({
  getOrSet: jest.fn().mockResolvedValue(value),
});

describe('PackageService', () => {
  it('serializes a decimal amount cached by an older build', async () => {
    // During a rollout (or after a rollback) another build can cache the
    // decimal column's string; the API must still return a number.
    const redis = cached([
      { id: 'p1', name: 'Weekly', frequency: 'WEEKLY', amount: '1000.00' },
    ]);
    const service = new PackageService({} as never, redis as never);
    const [pkg] = await service.getAllPackages();
    expect(pkg.amount).toBe(1000);
  });

  it('serializes a single cached package too', async () => {
    const redis = cached({ id: 'p1', amount: '2500.00' });
    const service = new PackageService({} as never, redis as never);
    await expect(service.getPackageById('p1')).resolves.toMatchObject({
      amount: 2500,
    });
  });

  it('is undefined for an unknown package', async () => {
    const service = new PackageService({} as never, cached(null) as never);
    await expect(service.getPackageById('nope')).resolves.toBeUndefined();
  });
});
