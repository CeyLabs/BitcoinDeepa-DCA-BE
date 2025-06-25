import { Module } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { JwtService } from '@nestjs/jwt';

@Module({
  providers: [SubscriptionService, JwtService],
  controllers: [SubscriptionController],
})
export class SubscriptionModule {}
