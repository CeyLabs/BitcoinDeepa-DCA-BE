import {
  Body,
  Controller,
  Headers,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { P2pEnabledGuard } from '../../common/p2p-enabled';
import { P2pInitDto } from './dto/p2p.dto';
import { P2pService } from './p2p.service';
import { reply } from './p2p.controller';

/**
 * Creates the user's bot wallet if they never pressed Start in the bot
 * (relayed to the bot's /api/v1/init, signed like the P2P calls). Call on
 * every app open - Mini App: after requestWriteAccess, with the raw initData
 * in X-Telegram-Init-Data. 201 new wallet, 200 existing. can_message false
 * means the bot can't message the user yet: offer t.me/<bot>?start=...
 */
@Controller('init')
@UseGuards(P2pEnabledGuard, ConditionalAuthGuard)
export class InitController {
  constructor(private readonly p2p: P2pService) {}

  @Post()
  async init(
    @CurrentUser() user: JwtPayload,
    @Headers('x-telegram-init-data') initData: string | undefined,
    @Body() dto: P2pInitDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.init(user.id, initData, dto ?? {}));
  }
}
