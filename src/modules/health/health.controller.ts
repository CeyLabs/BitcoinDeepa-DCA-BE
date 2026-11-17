import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private healthIndicator: HealthIndicatorService,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
    private knexService: KnexService,
    private redisService: RedisService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 150 * 1024 * 1024),
      () =>
        this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.9 }),
      async () => {
        const indicator = this.healthIndicator.check('database');
        try {
          await this.knexService.knex.raw('SELECT 1');
          return indicator.up();
        } catch (error) {
          return indicator.down({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      async () => {
        const indicator = this.healthIndicator.check('redis');
        return (await this.redisService.ping())
          ? indicator.up()
          : indicator.down({ error: 'Redis ping failed' });
      },
    ]);
  }

  @Get('simple')
  simple() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    };
  }
}
