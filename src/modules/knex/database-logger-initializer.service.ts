import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseLoggerService } from './database-logger.service';
import { DatabaseSystemLogger } from './database-system-logger.service';

@Injectable()
export class DatabaseLoggerInitializer implements OnModuleInit {
  constructor(
    private readonly databaseLoggerService: DatabaseLoggerService,
    private readonly databaseSystemLogger: DatabaseSystemLogger,
  ) {}

  onModuleInit() {
    // Initialize the system logger with database logger service
    this.databaseSystemLogger.setDatabaseLogger(this.databaseLoggerService);
  }
}