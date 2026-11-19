import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { DatabaseSystemLogger } from './modules/knex/database-system-logger.service';
import { randomUUID, webcrypto } from 'crypto';
import { runMigrationsOnStartup } from './utils/run-migrations';

// Polyfill global.crypto if not available (older Node runtimes). Falls back
// to Node's real WebCrypto implementation rather than an empty object —
// libraries like jose call crypto.subtle directly off the global and would
// break silently (e.g. "Cannot read properties of undefined (reading
// 'importKey')") if this were stubbed out with `{}`.
if (typeof global.crypto === 'undefined') {
  global.crypto = webcrypto as unknown as Crypto;
}
if (typeof global.crypto.randomUUID === 'undefined') {
  global.crypto.randomUUID = randomUUID;
}

async function bootstrap() {
  // Apply pending migrations before any module touches the DB
  await runMigrationsOnStartup();

  // Create the app with custom logger
  // rawBody is needed to verify HMAC signatures on incoming webhooks (Didit)
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  // Get the custom logger from the DI container
  const databaseLogger = app.get(DatabaseSystemLogger);

  // Use the custom logger for the application
  app.useLogger(databaseLogger);

  configureApp(app);

  const port = process.env.PORT || 3000;
  await app.listen(port);

  databaseLogger.log(`🚀 Application is running on port ${port}`);
  databaseLogger.log(`📊 Health check available at: /health`);
}

bootstrap().catch((error) => {
  console.error('Error during application bootstrap:', error);
  // Exit non-zero so Railway's ON_FAILURE restart policy kicks in
  process.exit(1);
});
