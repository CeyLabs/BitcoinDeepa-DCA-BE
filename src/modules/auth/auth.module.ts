import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { ConditionalAuthGuard } from './conditional-auth.guard';
import { AdminKeyGuard } from './admin-key.guard';
import { SessionService } from './session.service';
import { UserModule } from '../user/user.module';

/**
 * Who is calling: sessions, the guard and the Telegram verifiers. Modules
 * that use ConditionalAuthGuard import this. The login routes live in
 * LoginModule (they also need the P2P relay, which imports this module).
 */
@Module({
  imports: [
    // Only to verify legacy 7-day JWTs until they expire
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
    forwardRef(() => UserModule),
  ],
  providers: [AuthService, ConditionalAuthGuard, AdminKeyGuard, SessionService],
  exports: [
    AuthService,
    ConditionalAuthGuard,
    AdminKeyGuard,
    JwtModule,
    SessionService,
  ],
})
export class AuthModule {}
