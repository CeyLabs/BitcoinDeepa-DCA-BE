import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { PackageModule } from './modules/package/package.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { TransactionModule } from './modules/transaction/transaction.module';
import { RedisModule } from './modules/redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { SettlementModule } from './modules/settlement/settlement.module';
import { DiditModule } from './modules/didit/didit.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    RedisModule,
    SubscriptionModule,
    PackageModule,
    AuthModule,
    UserModule,
    TransactionModule,
    HealthModule,
    SettlementModule,
    DiditModule,
  ],
})
export class AppModule {}
