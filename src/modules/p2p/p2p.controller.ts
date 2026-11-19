import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { P2pEnabledGuard } from '../../common/p2p-enabled';
import { P2pResolveDto, P2pSendDto } from './dto/p2p.dto';
import { P2pService, type P2pResult } from './p2p.service';
import { TransferIdPipe } from './transfer-id.pipe';

/**
 * Send sats from the user's own bot wallet to another bot user (relayed to
 * the bot's /api/v1/p2p). In the Mini App, send the raw initData in
 * X-Telegram-Init-Data; on the web, the latest "Log In with Telegram" is used.
 * Sends need a credential under 10 min old: a 403 credential_stale (or the
 * bot's refusal, 403 credential_rejected) asks the app to get a fresh one
 * (reopen the Mini App / log in again), then retry with the same
 * idempotency_key. 401 is only ever our own session.
 */
@Controller('p2p')
@UseGuards(P2pEnabledGuard, ConditionalAuthGuard)
export class P2pController {
  constructor(private readonly p2p: P2pService) {}

  @Get('me')
  async me(
    @CurrentUser() user: JwtPayload,
    @Headers('x-telegram-init-data') initData: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.me(user.id, initData));
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @CurrentUser() user: JwtPayload,
    @Headers('x-telegram-init-data') initData: string | undefined,
    @Body() dto: P2pResolveDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.resolveRecipient(user.id, initData, dto));
  }

  /** 200 when final (completed/failed), 202 while it's still going */
  @Post('send')
  async send(
    @CurrentUser() user: JwtPayload,
    @Headers('x-telegram-init-data') initData: string | undefined,
    @Body() dto: P2pSendDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.send(user.id, initData, dto));
  }

  @Get('transfers/:id')
  async transfer(
    @CurrentUser() user: JwtPayload,
    @Headers('x-telegram-init-data') initData: string | undefined,
    @Param('id', TransferIdPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.p2p.transfer(user.id, initData, id));
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
