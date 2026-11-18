import type { Pool } from 'pg';
import type { betterAuth as BetterAuth } from 'better-auth';
import type { admin as AdminPlugin } from 'better-auth/plugins';
import type { APIError as BetterAuthAPIError } from 'better-auth/api';
import type { toNodeHandler as ToNodeHandler } from 'better-auth/node';
import {
  ADMIN_AUTH_BASE_PATH,
  ADMIN_ROLE,
  adminAppOrigins,
} from './admin-auth.constants';

// better-auth is ESM-only. tsc compiles this project to CommonJS and would
// turn a normal import into require(), which Jest can't load - so load it the
// same way auth.service.ts loads jose. Not eval of user input.
// The random comment gives each module instance its own source: V8 caches
// compiled functions by source text, and in Jest a cached copy would keep
// importing through the first test file's (already torn down) environment.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importEsm = new Function(
  'specifier',
  `return import(specifier) // ${Math.random()}`,
) as <T>(specifier: string) => Promise<T>;

export interface AdminAuthOptions {
  pool: Pool;
  /** Unset in development: Better Auth then uses its built-in dev secret. */
  secret: string | undefined;
  baseURL: string;
  production: boolean;
}

export async function createAdminAuth({
  pool,
  secret,
  baseURL,
  production,
}: AdminAuthOptions) {
  const { betterAuth } = await importEsm<{ betterAuth: typeof BetterAuth }>(
    'better-auth',
  );
  const { admin } = await importEsm<{ admin: typeof AdminPlugin }>(
    'better-auth/plugins',
  );
  const { APIError } = await importEsm<{ APIError: typeof BetterAuthAPIError }>(
    'better-auth/api',
  );

  const timestamps = { createdAt: 'created_at', updatedAt: 'updated_at' };

  return betterAuth({
    appName: 'BitcoinDeepa Admin',
    database: pool,
    secret,
    baseURL,
    basePath: ADMIN_AUTH_BASE_PATH,
    trustedOrigins: adminAppOrigins(),
    emailAndPassword: {
      enabled: true,
      // Admins are created with `bun run admin:create`, never self-registered
      disableSignUp: true,
      minPasswordLength: 12,
    },
    user: {
      modelName: 'admin_user',
      fields: { emailVerified: 'email_verified', ...timestamps },
    },
    session: {
      modelName: 'admin_session',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        ...timestamps,
      },
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh once a day
    },
    account: {
      modelName: 'admin_account',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        ...timestamps,
      },
    },
    verification: {
      modelName: 'admin_verification',
      fields: { expiresAt: 'expires_at', ...timestamps },
    },
    plugins: [
      admin({
        defaultRole: 'user',
        adminRoles: [ADMIN_ROLE],
        schema: {
          user: {
            fields: { banReason: 'ban_reason', banExpires: 'ban_expires' },
          },
          session: { fields: { impersonatedBy: 'impersonated_by' } },
        },
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Only admins may hold a session - anyone else is refused at sign-in
          before: async (session) => {
            const { rows } = await pool.query<{ role: string | null }>(
              'SELECT role FROM admin_user WHERE id = $1',
              [session.userId],
            );
            if (rows[0]?.role !== ADMIN_ROLE) {
              // APIError extends Error; its base type just doesn't resolve under
              // this project's CommonJS module resolution.
              // eslint-disable-next-line @typescript-eslint/only-throw-error
              throw new APIError('FORBIDDEN', {
                message: 'Only admins can sign in to the dashboard',
              });
            }
            return { data: session };
          },
        },
      },
    },
    rateLimit: { enabled: production, window: 60, max: 30 },
    advanced: {
      cookiePrefix: 'bd-admin',
      // The dashboard and the API share one registrable domain in production
      // (admin.<domain> / api.<domain>), so the cookie is first-party: Lax is
      // sent on the dashboard's requests, survives Safari's third-party
      // cookie blocking, and isn't sent on cross-site POSTs.
      defaultCookieAttributes: production
        ? { sameSite: 'lax', secure: true }
        : { sameSite: 'lax', secure: false },
    },
  });
}

/** Node/Express request handler for everything under ADMIN_AUTH_BASE_PATH. */
export async function createAdminAuthHandler(auth: AdminAuth) {
  const { toNodeHandler } = await importEsm<{
    toNodeHandler: typeof ToNodeHandler;
  }>('better-auth/node');
  return toNodeHandler(auth);
}

export type AdminAuth = Awaited<ReturnType<typeof createAdminAuth>>;
export type AdminSession = NonNullable<
  Awaited<ReturnType<AdminAuth['api']['getSession']>>
>;
