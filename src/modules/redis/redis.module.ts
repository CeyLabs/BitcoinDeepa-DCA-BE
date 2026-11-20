import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// Global so every module shares one RedisService (and one connection).
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
