import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { UserModule } from '../user/user.module';
import { P2pController } from './p2p.controller';
import { InitController } from './init.controller';
import { P2pService } from './p2p.service';
import { P2pBotClient } from './p2p-bot.client';
import { P2pCredentialService } from './p2p-credential.service';

@Module({
  imports: [AuthModule, TelegramLoggerModule, UserModule],
  controllers: [P2pController, InitController],
  providers: [P2pService, P2pBotClient, P2pCredentialService],
  exports: [P2pService],
})
export class P2pModule {}
