import type { CookieOptions, Request } from 'express';

/**
 * Cookie names and options for the user app's sessions. The cookie belongs
 * to this API's host; the app calls us with credentials (CORS for APP_URL).
 *
 * - Production: the app and API share a site (app.bitcoindeepa.com /
 *   api.bitcoindeepa.com), so SameSite=Lax is sent on the app's fetches. The
 *   __Host- prefix makes the browser enforce Secure, Path=/ and no Domain.
 * - Dev/staging on two sites (a vercel.app app, a railway.app API):
 *   APP_COOKIE_SAME_SITE=none makes it SameSite=None; Secure (HTTPS needed;
 *   refused in production; Safari and the iOS Telegram WebView still block
 *   it - the Mini App uses a Bearer token and isn't affected). Writes stay
 *   protected by the Origin check in ConditionalAuthGuard.
 */
const isProduction = () => process.env.NODE_ENV === 'production';
const crossSite = () =>
  !isProduction() && process.env.APP_COOKIE_SAME_SITE === 'none';

export const sessionCookieName = (): string =>
  isProduction() ? '__Host-sid' : 'sid';

export const attemptCookieName = (): string =>
  isProduction() ? '__Host-tg_attempt' : 'tg_attempt';

/** HttpOnly, Path=/, never a Domain; Lax (None in cross-site dev); Secure in production */
export const cookieOptions = (maxAgeMs?: number): CookieOptions => ({
  httpOnly: true,
  secure: isProduction() || crossSite(),
  sameSite: crossSite() ? 'none' : 'lax',
  path: '/',
  ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
});

/** Parse the Cookie header (no cookie-parser middleware in this app) */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** Comma-separated APP_URL → the user app's allowed origins */
export function appOrigins(): string[] {
  return (process.env.APP_URL ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
