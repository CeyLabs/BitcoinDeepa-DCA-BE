import { Injectable, Logger } from '@nestjs/common';
import { KnexService } from './knex.service';

export type LogType = 'info' | 'warn' | 'error';

@Injectable()
export class DatabaseLoggerService {
  private readonly logger = new Logger(DatabaseLoggerService.name);
  private readonly tableName = 'log';

  constructor(private readonly knexService: KnexService) {}

  async log(message: string, type: LogType = 'info'): Promise<void> {
    try {
      await this.knexService.knex(this.tableName).insert({
        text: message,
        type,
      });
    } catch (error) {
      this.logger.error('Failed to write log to database', error);
    }
  }

  async info(message: string): Promise<void> {
    await this.log(message, 'info');
  }

  async warn(message: string): Promise<void> {
    await this.log(message, 'warn');
  }

  async error(message: string): Promise<void> {
    await this.log(message, 'error');
  }
}