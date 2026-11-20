/** DI token for the Better Auth instance used by the admin dashboard. */
export const ADMIN_AUTH = Symbol('ADMIN_AUTH');

/** DI token for the Express handler that serves ADMIN_AUTH_BASE_PATH. */
export const ADMIN_AUTH_HANDLER = Symbol('ADMIN_AUTH_HANDLER');

/** Where the Better Auth handler is mounted (see app.setup.ts). */
export const ADMIN_AUTH_BASE_PATH = '/api/admin-auth';

export const ADMIN_ROLE = 'admin';

/** Comma-separated ADMIN_APP_URL -> list of allowed admin dashboard origins. */
export function adminAppOrigins(): string[] {
  return (process.env.ADMIN_APP_URL ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
