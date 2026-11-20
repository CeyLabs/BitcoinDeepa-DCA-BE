import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminKeyGuard } from './admin-key.guard';

const ctxWithHeader = (value?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        header: (name: string) => (name === 'x-admin-key' ? value : undefined),
      }),
    }),
  }) as unknown as ExecutionContext;

describe('AdminKeyGuard', () => {
  const guard = new AdminKeyGuard();
  const original = process.env.ADMIN_API_KEY;

  afterEach(() => {
    process.env.ADMIN_API_KEY = original;
  });

  it('allows the configured key', () => {
    process.env.ADMIN_API_KEY = 'admin-key';
    expect(guard.canActivate(ctxWithHeader('admin-key'))).toBe(true);
  });

  it('rejects a wrong or missing key', () => {
    process.env.ADMIN_API_KEY = 'admin-key';
    expect(() => guard.canActivate(ctxWithHeader('nope'))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(ctxWithHeader(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('is closed when ADMIN_API_KEY is not set', () => {
    delete process.env.ADMIN_API_KEY;
    expect(() => guard.canActivate(ctxWithHeader(''))).toThrow(
      ForbiddenException,
    );
  });
});
