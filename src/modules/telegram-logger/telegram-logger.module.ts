import { Module } from '@nestjs/common';
import { TelegramLoggerService } from './telegram-logger.service';

@Module({
  providers: [TelegramLoggerService],
  exports: [TelegramLoggerService],
})
export class TelegramLoggerModule {}