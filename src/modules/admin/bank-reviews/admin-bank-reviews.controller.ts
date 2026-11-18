import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminSessionGuard } from '../auth/admin-session.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import type { AdminSession } from '../auth/admin-auth.config';
import { BankAccountService } from '../../bank-account/bank-account.service';
import { AdminBankReviewsService } from './admin-bank-reviews.service';
import {
  ListBankReviewsQueryDto,
  RejectBankAccountDto,
} from './dto/bank-reviews.dto';

const reviewer = ({ user }: AdminSession) => `admin:${user.email || user.id}`;
const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('admin/bank-reviews')
@UseGuards(AdminSessionGuard)
export class AdminBankReviewsController {
  constructor(
    private readonly reviews: AdminBankReviewsService,
    private readonly bankAccounts: BankAccountService,
  ) {}

  @Get()
  list(@Query() query: ListBankReviewsQueryDto) {
    return this.reviews.list(query);
  }

  @Get('pending-count')
  pendingCount() {
    return this.reviews.pendingCount();
  }

  /** Temporary (5 min) link to the uploaded bank statement */
  @Get(':id/statement')
  statement(@Param('id', uuid) id: string) {
    return this.bankAccounts.statementUrl(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', uuid) id: string,
    @CurrentAdmin() admin: AdminSession,
  ) {
    const row = await this.bankAccounts.approve(id, reviewer(admin));
    return { id: row.id, status: row.status };
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', uuid) id: string,
    @Body() body: RejectBankAccountDto,
    @CurrentAdmin() admin: AdminSession,
  ) {
    const row = await this.bankAccounts.reject(
      id,
      body.reason,
      reviewer(admin),
    );
    return { id: row.id, status: row.status };
  }
}
