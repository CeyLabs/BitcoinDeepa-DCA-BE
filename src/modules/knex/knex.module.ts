import { Global, Module } from '@nestjs/common';
import { KnexService } from './knex.service';
import { DatabaseLoggerService } from './database-logger.service';
import { DatabaseSystemLogger } from './database-system-logger.service';
import { DatabaseLoggerInitializer } from './database-logger-initializer.service';

@Global()
@Module({
  providers: [
    KnexService,
    DatabaseLoggerService,
    DatabaseSystemLogger,
    DatabaseLoggerInitializer,
  ],
  exports: [KnexService, DatabaseLoggerService, DatabaseSystemLogger],
})
export class KnexModule {}
