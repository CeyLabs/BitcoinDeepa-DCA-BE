import { Module } from '@nestjs/common';
import { SubscriptionController } from './modules/subscription/subscription.controller';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { PackageController } from './modules/package/package.controller';
import { PackageModule } from './modules/package/package.module';
import { PackageService } from './modules/package/package.service';
import { SubscriptionService } from './modules/subscription/subscription.service';

@Module({
  imports: [SubscriptionModule, PackageModule],
  controllers: [SubscriptionController, PackageController],
  providers: [PackageService, SubscriptionService],
})
export class AppModule {}
