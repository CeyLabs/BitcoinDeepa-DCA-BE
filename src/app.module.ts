import { Module } from '@nestjs/common';
import { SubscriptionController } from './modules/subscription/subscription.controller';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { PackageController } from './modules/package/package.controller';
import { PackageModule } from './modules/package/package.module';
import { PackageService } from './modules/package/package.service';
import { SubscriptionService } from './modules/subscription/subscription.service';
import { AuthModule } from './modules/auth/auth.module';
import { JwtService } from '@nestjs/jwt';

@Module({
  imports: [SubscriptionModule, PackageModule, AuthModule],
  controllers: [SubscriptionController, PackageController],
  providers: [PackageService, SubscriptionService, JwtService],
})
export class AppModule {}
