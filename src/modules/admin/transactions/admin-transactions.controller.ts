import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../auth/admin-session.guard';
import { AdminTransactionsService } from './admin-transactions.service';
import { ListTransactionsQueryDto } from './dto/list-transactions.dto';

@Controller('admin/transactions')
@UseGuards(AdminSessionGuard)
export class AdminTransactionsController {
  constructor(private readonly transactions: AdminTransactionsService) {}

  @Get()
  list(@Query() query: ListTransactionsQueryDto) {
    return this.transactions.list(query);
  }
}
