import { Injectable, ConsoleLogger, LoggerService } from '@nestjs/common';
import { DatabaseLoggerService, LogType } from './database-logger.service';

@Injectable()
export class DatabaseSystemLogger extends ConsoleLogger implements LoggerService {
  private dbLogger: DatabaseLoggerService | null = null;
  
  // Store logs before database is ready
  private logQueue: Array<{ message: string; type: LogType }> = [];
  private isDatabaseReady = false;

  constructor() {
    super('SystemLogger');
  }

  setDatabaseLogger(dbLogger: DatabaseLoggerService) {
    this.dbLogger = dbLogger;
    this.isDatabaseReady = true;
    
    // Process queued logs
    this.processLogQueue();
  }

  private async processLogQueue() {
    if (!this.dbLogger) return;
    
    for (const queuedLog of this.logQueue) {
      try {
        await this.dbLogger.log(queuedLog.message, queuedLog.type);
      } catch (error) {
        // Fallback to console if database logging fails
        super.error(`Failed to write queued log to database: ${error.message}`, 'DatabaseSystemLogger');
      }
    }
    
    this.logQueue = [];
  }

  private async writeToDatabase(message: string, type: LogType) {
    if (this.isDatabaseReady && this.dbLogger) {
      try {
        await this.dbLogger.log(message, type);
      } catch (error) {
        // Fallback to console if database logging fails
        super.error(`Failed to write to database: ${error.message}`, 'DatabaseSystemLogger');
      }
    } else {
      // Queue the log for later processing
      this.logQueue.push({ message, type });
    }
  }

  log(message: any, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(message, context, 'LOG');
    super.log(message, context);
    this.writeToDatabase(formattedMessage, 'info').catch(() => {});
  }

  error(message: any, trace?: string, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(message, context, 'ERROR', trace);
    super.error(message, trace, context);
    this.writeToDatabase(formattedMessage, 'error').catch(() => {});
  }

  warn(message: any, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(message, context, 'WARN');
    super.warn(message, context);
    this.writeToDatabase(formattedMessage, 'warn').catch(() => {});
  }

  debug(message: any, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(message, context, 'DEBUG');
    super.debug(message, context);
    this.writeToDatabase(formattedMessage, 'info').catch(() => {});
  }

  verbose(message: any, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(message, context, 'VERBOSE');
    super.verbose(message, context);
    this.writeToDatabase(formattedMessage, 'info').catch(() => {});
  }

  private formatDatabaseMessage(message: any, context?: string, level?: string, trace?: string): string {
    const timestamp = new Date().toISOString();
    const ctx = context ? `[${context}] ` : '';
    const lvl = level ? `[${level}] ` : '';
    const msg = typeof message === 'object' ? JSON.stringify(message) : String(message);
    const traceInfo = trace ? ` - ${trace}` : '';
    
    return `${timestamp} ${lvl}${ctx}${msg}${traceInfo}`;
  }
}