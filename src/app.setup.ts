import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as cors from 'cors';
import type { Express, Request, RequestHandler } from 'express';
import {
  ADMIN_AUTH_BASE_PATH,
  ADMIN_AUTH_HANDLER,
  adminAppOrigins,
} from './modules/admin/auth/admin-auth.constants';
import { appOrigins } from './modules/auth/cookies';

/**
 * CORS for every route. The admin dashboard (ADMIN_APP_URL) and the user app
 * (APP_URL) send session cookies, so their origins get an exact-match,
 * credentialed response. Other origins keep the CORS_ORIGIN policy WITHOUT
 * credentials: a credentialed response there would let that origin read
 * data from a signed-in browser.
 */
function corsOptions(): cors.CorsOptionsDelegate<Request> {
  const adminOrigins = adminAppOrigins();
  return (req, callback) => {
    const origin = req.header('origin');
    // APP_URL is read per request (tests set it after the app starts)
    if (
      origin &&
      (adminOrigins.includes(origin) || appOrigins().includes(origin))
    ) {
      return callback(null, { origin, credentials: true });
    }
    callback(null, {
      origin: process.env.CORS_ORIGIN || '*',
      credentials: false,
    });
  };
}

/**
 * App-wide HTTP setup shared by main.ts and the e2e tests, so tests run the
 * app exactly as production does. (rawBody must be passed at creation time:
 * NestFactory.create(..., { rawBody: true }).)
 */
export function configureApp(app: INestApplication): void {
  const corsDelegate = corsOptions();

  // Better Auth (admin dashboard) reads the raw request itself, so it is
  // mounted straight on Express before Nest registers its body parsers and
  // CORS (both happen in app.init()/listen()) - hence its own CORS here.
  const express = app.getHttpAdapter().getInstance() as Express;

  // req.ip = the real client behind our proxies (rate limits, session ip).
  // Only trust the hops we actually have: trusting X-Forwarded-For blindly
  // lets any client pick its own IP.
  const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) express.set('trust proxy', trustProxy);
  express.use(ADMIN_AUTH_BASE_PATH, cors(corsDelegate));
  express.all(
    `${ADMIN_AUTH_BASE_PATH}/*splat`,
    app.get<RequestHandler>(ADMIN_AUTH_HANDLER),
  );

  // Validate every request body against its DTO class; strip unknown fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Run onModuleDestroy (close DB pool / Redis) on SIGTERM during redeploys
  app.enableShutdownHooks();

  app.enableCors(corsDelegate);
}

/** TRUST_PROXY: a hop count ("2") or proxy IPs/CIDRs ("10.0.0.0/8,1.2.3.4") */
export function trustProxySetting(
  value: string | undefined,
): number | string[] | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
