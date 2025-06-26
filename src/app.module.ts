import { Module } from '@nestjs/common';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { PackageModule } from './modules/package/package.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [SubscriptionModule, PackageModule, AuthModule, UserModule],
})
export class AppModule {}
