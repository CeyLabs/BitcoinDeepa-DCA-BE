import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Knex, knex as createKnex } from 'knex';
import config from '../../../knexfile';
import { errorMessage } from '../../common/error-message';

type KnexConfig = Record<string, Knex.Config>;

interface IDbConnection {
  query: (
    sql: string,
    callback: (err: Error | null, result?: unknown) => void,
  ) => void;
}

@Injectable()
export class KnexService implements OnModuleInit, OnModuleDestroy {
  public knex!: Knex;
  private readonly logger = new Logger(KnexService.name);
  private readonly NODE_ENV = process.env.NODE_ENV || 'development';
  private connectionCount = 0;
  private hasLoggedInitialConnection = false;

  onModuleInit(): void {
    // Use the appropriate environment configuration
    const configToUse =
      (config as KnexConfig)[this.NODE_ENV] ||
      (config as KnexConfig).development;

    // Pool sizes/timeouts come from knexfile.ts (single source of truth);
    // only the connection validator is added here.
    const poolConfig: Knex.PoolConfig = {
      ...(configToUse.pool || {}),
      afterCreate: (
        conn: IDbConnection,
        done: (err: Error | null, connection?: IDbConnection) => void,
      ) => {
        conn.query('SELECT 1', (err: Error | null) => {
          if (err) {
            this.logger.error('Error during connection validation', err);
            done(err, conn);
          } else {
            this.connectionCount++;
            // Only log the first successful connection to reduce noise
            if (!this.hasLoggedInitialConnection) {
              this.logger.log('Database connection established successfully');
              this.hasLoggedInitialConnection = true;
            }
            done(null, conn);
          }
        });
      },
    };

    this.knex = createKnex({ ...configToUse, pool: poolConfig });

    // Log when connections open or close for debugging
    this.knex.on('query-error', (error: Error, query: { sql: string }) => {
      this.logger.error(`Query error: ${errorMessage(error)}`, {
        error,
        query: query.sql,
      });
    });

    // Log database setup completion
    this.logger.log(
      `Database connection pool configured (min: ${poolConfig.min}, max: ${poolConfig.max})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.knex) {
      try {
        await this.knex.destroy();
        this.logger.log('Database connection closed gracefully');
      } catch (error) {
        this.logger.error('Error closing database connection', error);
      }
    }
  }
}
