import { Module } from '@nestjs/common';
import { AdminAuthModule } from './auth/admin-auth.module';

/**
 * Everything behind the admin dashboard (BitcoinDeepa-Admin-FE). Auth is
 * global, so every sub-module can use AdminSessionGuard.
 */
@Module({
  imports: [AdminAuthModule],
})
export class AdminModule {}
