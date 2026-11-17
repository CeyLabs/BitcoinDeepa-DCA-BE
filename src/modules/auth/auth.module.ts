import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConditionalAuthGuard } from './conditional-auth.guard';
import { AdminKeyGuard } from './admin-key.guard';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
    forwardRef(() => UserModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, ConditionalAuthGuard, AdminKeyGuard],
  exports: [AuthService, ConditionalAuthGuard, AdminKeyGuard, JwtModule],
})
export class AuthModule {}
