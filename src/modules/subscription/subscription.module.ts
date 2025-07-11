import { Module } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { KnexModule } from '../knex/knex.module';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';
import { PackageModule } from '../package/package.module';
import { PayHereModule } from '../payhere/payhere.module';

@Module({
  imports: [KnexModule, AuthModule, UserModule, PackageModule, PayHereModule],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
  controllers: [SubscriptionController],
})
export class SubscriptionModule {}
