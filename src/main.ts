import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseSystemLogger } from './modules/knex/database-system-logger.service';
import { randomUUID } from 'crypto';

// Polyfill for crypto.randomUUID if not available (Node.js < 14.17.0)
if (typeof global.crypto === 'undefined') {
  global.crypto = {} as any;
}
if (typeof global.crypto.randomUUID === 'undefined') {
  global.crypto.randomUUID = randomUUID;
}

async function bootstrap() {
  // Create the app with custom logger
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // Get the custom logger from the DI container
  const databaseLogger = app.get(DatabaseSystemLogger);

  // Use the custom logger for the application
  app.useLogger(databaseLogger);

  // Enable CORS for production deployment
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  databaseLogger.log(`🚀 Application is running on port ${port}`);
  databaseLogger.log(`📊 Health check available at: /health`);
}

void bootstrap();
