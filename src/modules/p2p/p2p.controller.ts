import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { SessionRequiredGuard } from '../auth/session-required.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { P2pEnabledGuard } from '../../common/p2p-enabled';
import { P2pResolveDto, P2pSendDto } from './dto/p2p.dto';
import { P2pService, type P2pResult } from './p2p.service';
import { TransferIdPipe } from './transfer-id.pipe';

/**
 * Send sats from the user's own bot wallet to another bot user (relayed to
 * the bot's /api/v1/p2p). Our session names the user; no Telegram credential
 * is needed after login. 403 relogin_required means the bot hasn't linked the
 * user, or this is a legacy JWT (log in again), then retry with the same
 * idempotency_key. 401 is only ever our own session.
 */
@Controller('p2p')
@UseGuards(P2pEnabledGuard, ConditionalAuthGuard, SessionRequiredGuard)
export class P2pController {
  constructor(private readonly p2p: P2pService) {}

  @Get('me')
  async me(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.me(user.id));
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @CurrentUser() user: JwtPayload,
    @Body() dto: P2pResolveDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.resolveRecipient(user.id, dto));
  }

  /** 200 when final (completed/failed), 202 while it's still going */
  @Post('send')
  async send(
    @CurrentUser() user: JwtPayload,
    @Body() dto: P2pSendDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.send(user.id, dto));
  }

  @Get('transfers/:id')
  async transfer(
    @CurrentUser() user: JwtPayload,
    @Param('id', TransferIdPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.transfer(user.id, id));
  }
}

/** Keep the bot's status code (200 vs 202 matters to the app) */
export function reply(
  res: Response,
  result: P2pResult,
): Record<string, unknown> {
  res.status(result.status);
  return result.body;
}
