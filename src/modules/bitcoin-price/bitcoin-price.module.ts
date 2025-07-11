import { Module } from '@nestjs/common';
import { BitcoinPriceService } from './bitcoin-price.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [BitcoinPriceService],
  exports: [BitcoinPriceService],
})
export class BitcoinPriceModule {}
