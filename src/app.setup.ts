import { INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * App-wide HTTP setup shared by main.ts and the e2e tests, so tests run the
 * app exactly as production does. (rawBody must be passed at creation time:
 * NestFactory.create(..., { rawBody: true }).)
 */
export function configureApp(app: INestApplication): void {
  // Validate every request body against its DTO class; strip unknown fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Run onModuleDestroy (close DB pool / Redis) on SIGTERM during redeploys
  app.enableShutdownHooks();

  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  });
}
