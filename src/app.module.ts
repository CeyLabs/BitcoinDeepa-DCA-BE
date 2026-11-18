import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { AdminModule } from './modules/admin/admin.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
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
    AdminModule,
  ],
})
export class AppModule {}
