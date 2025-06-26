import { Module } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { JwtService } from '@nestjs/jwt';
import { KnexModule } from '../knex/knex.module';
import { UserService } from '../user/user.service';
import { PackageService } from '../package/package.service';

@Module({
  imports: [KnexModule],
  providers: [SubscriptionService, JwtService, UserService, PackageService],
  exports: [SubscriptionService],
  controllers: [SubscriptionController],
})
export class SubscriptionModule {}
