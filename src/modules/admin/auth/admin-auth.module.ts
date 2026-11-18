import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Knex } from 'knex';
import { Pool } from 'pg';
import config from '../../../../knexfile';
import {
  type AdminAuth,
  createAdminAuth,
  createAdminAuthHandler,
} from './admin-auth.config';
import { ADMIN_AUTH, ADMIN_AUTH_HANDLER } from './admin-auth.constants';
import { AdminController } from './admin.controller';
import { AdminSessionGuard } from './admin-session.guard';

const ADMIN_AUTH_POOL = Symbol('ADMIN_AUTH_POOL');

/** Small dedicated pg pool for Better Auth, using the same DB settings as Knex. */
export function createAdminAuthPool(): Pool {
  const env = process.env.NODE_ENV || 'development';
  const knexConfig =
    (config as Record<string, Knex.Config>)[env] ?? config.development;
  const connection = knexConfig.connection;
  return new Pool({
    ...(typeof connection === 'string'
      ? { connectionString: connection }
      : (connection as object)),
    max: 5,
  });
}

@Global()
@Module({
  controllers: [AdminController],
  providers: [
    { provide: ADMIN_AUTH_POOL, useFactory: createAdminAuthPool },
    {
      provide: ADMIN_AUTH,
      inject: [ConfigService, ADMIN_AUTH_POOL],
      useFactory: (configService: ConfigService, pool: Pool) =>
        createAdminAuth({
          pool,
          secret: configService.get<string>('BETTER_AUTH_SECRET'),
          baseURL:
            configService.get<string>('BETTER_AUTH_URL') ||
            configService.get<string>('BASE_URL') ||
            `http://localhost:${configService.get<string>('PORT') ?? 3000}`,
          production: configService.get<string>('NODE_ENV') === 'production',
          sameSite: configService.get<string>('ADMIN_COOKIE_SAME_SITE'),
        }),
    },
    {
      provide: ADMIN_AUTH_HANDLER,
      inject: [ADMIN_AUTH],
      useFactory: (auth: AdminAuth) => createAdminAuthHandler(auth),
    },
    AdminSessionGuard,
  ],
  exports: [ADMIN_AUTH, ADMIN_AUTH_HANDLER, AdminSessionGuard],
})
export class AdminAuthModule implements OnModuleDestroy {
  constructor(@Inject(ADMIN_AUTH_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
