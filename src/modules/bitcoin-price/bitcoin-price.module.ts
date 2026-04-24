import { Module } from '@nestjs/common';
import { BitcoinPriceService } from './bitcoin-price.service';
import { RedisModule } from '../redis/redis.module';
import { CoinMarketCapModule } from '../coinmarketcap/coinmarketcap.module';

@Module({
  imports: [RedisModule, CoinMarketCapModule],
  providers: [BitcoinPriceService],
  exports: [BitcoinPriceService],
})
export class BitcoinPriceModule {}
