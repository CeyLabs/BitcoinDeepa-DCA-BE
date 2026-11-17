import { Module, forwardRef } from '@nestjs/common';
import { DiditService } from './didit.service';
import { DiditController } from './didit.controller';
import { KnexModule } from '../knex/knex.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [KnexModule, forwardRef(() => UserModule)],
  providers: [DiditService],
  controllers: [DiditController],
  exports: [DiditService],
})
export class DiditModule {}
