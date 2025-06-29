import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { BitcoinPriceModule } from '../bitcoin-price/bitcoin-price.module';
import { AuthModule } from '../auth/auth.module';
import { KnexModule } from '../knex/knex.module';

@Module({
  imports: [BitcoinPriceModule, AuthModule, KnexModule],
  controllers: [TransactionController],
  providers: [TransactionService],
})
export class TransactionModule {}
