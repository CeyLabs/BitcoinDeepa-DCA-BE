import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as cors from 'cors';
import type { Express, Request, RequestHandler } from 'express';
import {
  ADMIN_AUTH_BASE_PATH,
  ADMIN_AUTH_HANDLER,
  adminAppOrigins,
} from './modules/admin/auth/admin-auth.constants';

/**
 * CORS for every route. The admin dashboard sends its session cookie, so its
 * origins (ADMIN_APP_URL) get an exact-match, credentialed response; other
 * origins keep the CORS_ORIGIN policy.
 */
function corsOptions(): cors.CorsOptionsDelegate<Request> {
  const adminOrigins = adminAppOrigins();
  return (req, callback) => {
    const origin = req.header('origin');
    if (origin && adminOrigins.includes(origin)) {
      return callback(null, { origin, credentials: true });
    }
    callback(null, {
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
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
