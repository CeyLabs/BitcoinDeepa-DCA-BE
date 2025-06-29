import { Module } from '@nestjs/common';
import { BitcoinPriceService } from './bitcoin-price.service';

@Module({
  providers: [BitcoinPriceService],
  exports: [BitcoinPriceService],
})
export class BitcoinPriceModule {}
