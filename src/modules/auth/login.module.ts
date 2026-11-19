import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { TelegramOidcService } from './telegram-oidc.service';
import { SessionCleanupService } from './session-cleanup.service';
import { UserModule } from '../user/user.module';
import { P2pModule } from '../p2p/p2p.module';

/** The user-app login routes (/auth/*): web OIDC, Mini App, logout */
@Module({
  imports: [AuthModule, UserModule, P2pModule],
  controllers: [AuthController],
  providers: [TelegramOidcService, AuthRateLimitGuard, SessionCleanupService],
})
export class LoginModule {}
