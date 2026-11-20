import { Body, Controller, Get, Logger, Post, UseGuards } from '@nestjs/common';
import type { AdminSession } from '../auth/admin-auth.config';
import { AdminSessionGuard } from '../auth/admin-session.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { AdminAdminsService } from './admin-admins.service';
import { CreateAdminDto } from './dto/create-admin.dto';

@Controller('admin/admins')
@UseGuards(AdminSessionGuard)
export class AdminAdminsController {
  private readonly logger = new Logger(AdminAdminsController.name);

  constructor(private readonly admins: AdminAdminsService) {}

  @Get()
  list() {
    return this.admins.list();
  }

  @Post()
  async create(
    @Body() body: CreateAdminDto,
    @CurrentAdmin() { user }: AdminSession,
  ) {
    const created = await this.admins.create(body);
    this.logger.log(`Admin ${created.email} created by ${user.email}`);
    return created;
  }
}
