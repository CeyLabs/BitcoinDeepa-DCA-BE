import { Module } from '@nestjs/common';
import { CeyPayService } from './ceypay.service';

@Module({
  providers: [CeyPayService],
  exports: [CeyPayService],
})
export class CeyPayModule {}
