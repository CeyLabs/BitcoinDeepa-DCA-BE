import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { AuthModule } from '../auth/auth.module';
import { KnexModule } from '../knex/knex.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { DiditModule } from '../didit/didit.module';

@Module({
  imports: [AuthModule, KnexModule, TelegramLoggerModule, DiditModule],
  providers: [UserService],
  exports: [UserService],
  controllers: [UserController],
})
export class UserModule {}
