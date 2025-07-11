import { Module } from '@nestjs/common';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { PackageModule } from './modules/package/package.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { TransactionModule } from './modules/transaction/transaction.module';
import { RedisModule } from './modules/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    RedisModule,
    SubscriptionModule,
    PackageModule,
    AuthModule,
    UserModule,
    TransactionModule,
    HealthModule,
  ],
})
export class AppModule {}
