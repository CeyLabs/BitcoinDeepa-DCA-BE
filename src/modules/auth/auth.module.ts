import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConditionalAuthGuard } from './conditional-auth.guard';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'sample-secret-key',
      signOptions: { expiresIn: '7d' },
    }),
    forwardRef(() => UserModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, ConditionalAuthGuard],
  exports: [AuthService, ConditionalAuthGuard, JwtModule],
})
export class AuthModule {}
