import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../auth/admin-session.guard';
import { AdminMembersService } from './admin-members.service';
import { ListMembersQueryDto } from './dto/list-members.dto';

@Controller('admin/members')
@UseGuards(AdminSessionGuard)
export class AdminMembersController {
  constructor(private readonly members: AdminMembersService) {}

  @Get()
  list(@Query() query: ListMembersQueryDto) {
    return this.members.list(query);
  }
}
