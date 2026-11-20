import { Controller, Get, UseGuards } from '@nestjs/common';
import type { AdminSession } from './admin-auth.config';
import { AdminSessionGuard } from './admin-session.guard';
import { CurrentAdmin } from './current-admin.decorator';

@Controller('admin')
@UseGuards(AdminSessionGuard)
export class AdminController {
  @Get('me')
  me(@CurrentAdmin() { user }: AdminSession) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };
  }
}
