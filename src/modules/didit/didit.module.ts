import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiditService } from './didit.service';
import { DiditController } from './didit.controller';
import { KnexModule } from '../knex/knex.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [ConfigModule, KnexModule, UserModule],
  providers: [DiditService],
  controllers: [DiditController],
  exports: [DiditService],
})
export class DiditModule {}
