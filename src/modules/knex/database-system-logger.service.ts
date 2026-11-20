import {
  Injectable,
  ConsoleLogger,
  LoggerService,
  type LogLevel,
} from '@nestjs/common';
import { DatabaseLoggerService, LogType } from './database-logger.service';
import { errorMessage } from '../../common/error-message';
import { EXTERNAL_API_CONTEXT, useJsonLogs } from '../../common/dev-logging';

/** Railway's level names (its badges and @level filter): info, debug, warn, error */
/** JSON.stringify that survives circular objects (e.g. an error with a socket) */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

const RAILWAY_LEVEL: Record<LogLevel, string> = {
  log: 'info',
  debug: 'debug',
  verbose: 'debug',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

@Injectable()
export class DatabaseSystemLogger
  extends ConsoleLogger
  implements LoggerService
{
  private dbLogger: DatabaseLoggerService | null = null;

  // Store logs before database is ready
  private logQueue: Array<{ message: string; type: LogType }> = [];
  private isDatabaseReady = false;

  constructor() {
    // Development on Railway: one JSON object per line (see dev-logging.ts)
    super('SystemLogger', useJsonLogs() ? { json: true } : {});
  }

  /**
   * One JSON line in Railway's shape, always on stdout (Railway marks every
   * stderr line as an error, so `level` alone decides the badge):
   * - `level` as Railway names it (INFO / DEBUG / WARN / ERROR badge)
   * - `message`, `context`, `stack`
   * - when the message is an object with `msg` (external API calls), its
   *   fields at the top level, so they can be filtered (@api:CeyPay @status:500)
   */
  protected printAsJson(
    message: unknown,
    options: {
      context: string;
      logLevel: LogLevel;
      writeStreamType?: 'stdout' | 'stderr';
      errorStack?: unknown;
    },
  ): void {
    const base = {
      level: RAILWAY_LEVEL[options.logLevel] ?? options.logLevel,
      timestamp: new Date().toISOString(),
      ...(options.context && { context: options.context }),
      ...(options.errorStack ? { stack: options.errorStack } : {}),
    };
    let line: Record<string, unknown>;
    if (message && typeof message === 'object' && 'msg' in message) {
      const { msg, ...fields } = message as Record<string, unknown>;
      line = { ...base, message: msg, ...fields };
    } else if (message instanceof Error) {
      line = { ...base, message: message.message, stack: message.stack };
    } else {
      line = { ...base, message };
    }
    process.stdout.write(`${safeJson(line)}\n`);
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
        super.error(
          `Failed to write queued log to database: ${errorMessage(error)}`,
          'DatabaseSystemLogger',
        );
      }
    }

    this.logQueue = [];
  }

  private async writeToDatabase(message: string, type: LogType) {
    // Every external API call is logged in development: console only, or it
    // would flood the log table
    if (message.includes(`[${EXTERNAL_API_CONTEXT}]`)) return;
    if (this.isDatabaseReady && this.dbLogger) {
      try {
        await this.dbLogger.log(message, type);
      } catch (error) {
        // Fallback to console if database logging fails
        super.error(
          `Failed to write to database: ${errorMessage(error)}`,
          'DatabaseSystemLogger',
        );
      }
    } else {
      // Queue the log for later processing
      this.logQueue.push({ message, type });
    }
  }

  log(message: any, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(
      message,
      context,
      'LOG',
    );
    super.log(message, context);
    this.writeToDatabase(formattedMessage, 'info').catch(() => {});
  }

  error(message: any, trace?: string, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(
      message,
      context,
      'ERROR',
      trace,
    );
    super.error(message, trace, context);
    this.writeToDatabase(formattedMessage, 'error').catch(() => {});
  }

  warn(message: any, context?: string): void {
    const formattedMessage = this.formatDatabaseMessage(
      message,
      context,
      'WARN',
    );
    super.warn(message, context);
    this.writeToDatabase(formattedMessage, 'warn').catch(() => {});
  }

  // debug/verbose go to the console only - writing them to the DB log table
  // (e.g. every cache hit/miss) floods it and competes for pool connections.
  debug(message: any, context?: string): void {
    super.debug(message, context);
  }

  verbose(message: any, context?: string): void {
    super.verbose(message, context);
  }

  private formatDatabaseMessage(
    message: any,
    context?: string,
    level?: string,
    trace?: string,
  ): string {
    const timestamp = new Date().toISOString();
    const ctx = context ? `[${context}] ` : '';
    const lvl = level ? `[${level}] ` : '';
    const msg =
      // safeJson: a circular object (an error holding its socket) must not throw
      typeof message === 'object' ? safeJson(message) : String(message);
    const traceInfo = trace ? ` - ${trace}` : '';

    return `${timestamp} ${lvl}${ctx}${msg}${traceInfo}`;
  }
}
