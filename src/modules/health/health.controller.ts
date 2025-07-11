import { Controller, Get } from '@nestjs/common';
import { 
  HealthCheck, 
  HealthCheckService, 
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
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
      () => this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.9 }),
      async () => {
        try {
          await this.knexService.knex.raw('SELECT 1');
          return { database: { status: 'up' } };
        } catch (error) {
          return { database: { status: 'down', error: error.message } };
        }
      },
      async () => {
        try {
          const testKey = 'health_check_' + Date.now();
          await this.redisService.set(testKey, 'ok', { ttl: 10 });
          const value = await this.redisService.get(testKey);
          await this.redisService.del(testKey);
          
          if (value === 'ok') {
            return { redis: { status: 'up' } };
          } else {
            return { redis: { status: 'down', error: 'Test failed' } };
          }
        } catch (error) {
          return { redis: { status: 'down', error: error.message } };
        }
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