import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { KnexModule } from '../knex/knex.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [TerminusModule, KnexModule, RedisModule],
  controllers: [HealthController],
})
export class HealthModule {}
