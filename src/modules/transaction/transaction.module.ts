import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { BitcoinPriceModule } from '../bitcoin-price/bitcoin-price.module';

@Module({
  imports: [BitcoinPriceModule],
  controllers: [TransactionController],
  providers: [TransactionService],
})
export class TransactionModule {}
