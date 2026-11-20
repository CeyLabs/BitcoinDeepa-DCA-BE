import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminSessionGuard } from './admin-session.guard';
import type { AdminAuth } from './admin-auth.config';

const session = { user: { role: 'admin', banned: false } };
const auth = {
  api: { getSession: jest.fn().mockResolvedValue(session) },
} as unknown as AdminAuth;

function context(method: string, origin?: string): ExecutionContext {
  const req = {
    method,
    headers: origin ? { origin } : {},
    header: (name: string) => (name === 'origin' ? origin : undefined),
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AdminSessionGuard', () => {
  const guard = new AdminSessionGuard(auth);

  beforeEach(() => {
    process.env.ADMIN_APP_URL = 'https://admin.example.com';
  });

  it('lets reads through from any origin', async () => {
    await expect(guard.canActivate(context('GET'))).resolves.toBe(true);
  });

  it('accepts a write from the dashboard origin', async () => {
    await expect(
      guard.canActivate(context('POST', 'https://admin.example.com')),
    ).resolves.toBe(true);
  });

  it.each([undefined, 'https://evil.example', 'https://t.me'])(
    'refuses a write from origin %s (CSRF)',
    async (origin) => {
      await expect(
        guard.canActivate(context('POST', origin)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
