import { Module } from '@nestjs/common';
import { PackageService } from './package.service';
import { PackageController } from './package.controller';
import { KnexModule } from '../knex/knex.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [KnexModule, AuthModule],
  providers: [PackageService],
  controllers: [PackageController],
  exports: [PackageService],
})
export class PackageModule {}
