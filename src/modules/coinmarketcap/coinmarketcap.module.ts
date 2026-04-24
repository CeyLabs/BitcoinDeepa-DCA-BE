import { Module } from '@nestjs/common';
import { CoinMarketCapService } from './coinmarketcap.service';

@Module({
  providers: [CoinMarketCapService],
  exports: [CoinMarketCapService],
})
export class CoinMarketCapModule {}
