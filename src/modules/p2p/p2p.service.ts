import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { P2pBotClient, type P2pBotResponse } from './p2p-bot.client';
import {
  P2pCredentialService,
  type P2pPurpose,
  spendFreshUntil,
} from './p2p-credential.service';
import type { P2pResolveDto, P2pSendDto } from './dto/p2p.dto';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { errorMessage } from '../../common/error-message';

const P2P_PATH = '/api/v1/p2p';

/** What the controller sends back: the bot's status (200/202) and JSON */
export interface P2pResult {
  status: number;
  body: Record<string, unknown>;
}

/** For logs: the bot's error code, or the start of a plain-text answer */
const describeBody = (data: Record<string, unknown>, body: unknown): string =>
  typeof data.code === 'string'
    ? data.code
    : typeof body === 'string'
      ? body.slice(0, 80)
      : '';

const asObject = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

/**
 * The P2P relay: a user sends sats from their own bot wallet. We resolve the
 * user's Telegram credential, sign the call with the P2P key and pass the
 * bot's answer through (its messages are written for users). What isn't the
 * user's to fix - our signature, IP allowlist, a bot outage - is mapped:
 * - 401 bad_service_signature / 403 forbidden / plain-text 403 → 502
 *   p2p_unavailable, with an alert (at most hourly): it's our config
 * - no answer or a 5xx on /send → 502 outcome_unknown: it may have gone
 *   through; retrying with the same idempotency_key is safe (the bot returns
 *   the original transfer)
 * - no answer or a 5xx on a read → 503
 */
@Injectable()
export class P2pService {
  private readonly logger = new Logger(P2pService.name);

  constructor(
    private readonly bot: P2pBotClient,
    private readonly credentials: P2pCredentialService,
    private readonly redis: RedisService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  async me(userId: string, initData?: string): Promise<P2pResult> {
    const resolved = await this.credentials.resolve(userId, initData, 'read');
    const result = await this.call('GET', '/me', resolved.credential, 'read');
    return {
      ...result,
      body: {
        ...result.body,
        // For the app: warn (or ask for a fresh login) before a send fails
        credential: {
          platform: resolved.platform,
          spend_fresh_until: new Date(
            spendFreshUntil(resolved.issuedAt) * 1000,
          ).toISOString(),
        },
      },
    };
  }

  async resolveRecipient(
    userId: string,
    initData: string | undefined,
    dto: P2pResolveDto,
  ): Promise<P2pResult> {
    const { credential } = await this.credentials.resolve(
      userId,
      initData,
      'read',
    );
    return this.call('POST', '/resolve', credential, 'read', { to: dto.to });
  }

  async send(
    userId: string,
    initData: string | undefined,
    dto: P2pSendDto,
  ): Promise<P2pResult> {
    const { credential } = await this.credentials.resolve(
      userId,
      initData,
      'spend',
    );
    const result = await this.call('POST', '/send', credential, 'spend', {
      to_telegram_id: dto.to_telegram_id,
      amount: dto.amount,
      ...(dto.memo ? { memo: dto.memo } : {}),
      idempotency_key: dto.idempotency_key,
    });
    if (result.body.status === 'completed') {
      await this.clearWalletCaches(userId, dto.to_telegram_id);
    }
    return result;
  }

  async transfer(
    userId: string,
    initData: string | undefined,
    id: string,
  ): Promise<P2pResult> {
    const { credential } = await this.credentials.resolve(
      userId,
      initData,
      'read',
    );
    return this.call(
      'GET',
      `/transfers/${encodeURIComponent(id)}`,
      credential,
      'read',
    );
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    credential: Parameters<P2pBotClient['request']>[2],
    purpose: P2pPurpose,
    body?: Record<string, unknown>,
  ): Promise<P2pResult> {
    if (!this.bot.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'p2p_unavailable',
        message: 'Sending sats is not available right now.',
      });
    }
    let response: P2pBotResponse;
    try {
      response = await this.bot.request(
        method,
        `${P2P_PATH}${path}`,
        credential,
        body,
      );
    } catch (error) {
      this.logger.error(
        `P2P ${method} ${path}: no answer from the bot (${errorMessage(error)})`,
      );
      throw unreachable(purpose);
    }
    return this.mapResponse(method, path, purpose, response);
  }

  private async mapResponse(
    method: string,
    path: string,
    purpose: P2pPurpose,
    { status, body }: P2pBotResponse,
  ): Promise<P2pResult> {
    const data = asObject(body);
    if (status >= 200 && status < 300) return { status, body: data };

    const ourConfig =
      (status === 401 && data.code === 'bad_service_signature') ||
      (status === 403 &&
        (data.code === 'forbidden' || typeof body !== 'object'));
    if (ourConfig) {
      await this.alertUnavailable(
        `the bot rejected our P2P call ${method} ${path} (HTTP ${status} ${describeBody(data, body)})`,
      );
      throw new HttpException(
        {
          code: 'p2p_unavailable',
          message: 'Sending sats is not available right now. Try again later.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (status >= 500) {
      this.logger.error(
        `P2P ${method} ${path}: bot answered HTTP ${status} ${describeBody(data, body)}`,
      );
      // /me's 503 balance_unavailable is the user's to retry: keep its message
      if (purpose === 'read' && data.code && data.message) {
        throw new HttpException(data, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw unreachable(purpose);
    }
    // The bot refused the user's Telegram credential: our session is fine, so
    // not a 401 (the app signs the user out on 401). Same fix as stale.
    if (status === 401) {
      throw new HttpException(
        {
          code: 'credential_rejected',
          message:
            typeof data.message === 'string'
              ? data.message
              : 'Log in with Telegram again.',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    // The bot's own 4xx (recipient_not_found, rate_limited, ...)
    throw new HttpException(
      data.code
        ? data
        : { code: 'p2p_error', message: 'Something went wrong. Try again.' },
      status,
    );
  }

  /** Our signature, key or IP allowlist: every P2P call fails until fixed */
  private async alertUnavailable(reason: string): Promise<void> {
    this.logger.error(`P2P unavailable: ${reason}`);
    if (await this.redis.setIfAbsent('dca:alert:p2p-unavailable', 60 * 60)) {
      await this.telegramLogger
        .logAlert(
          'P2P',
          `P2P sends are failing: ${reason}. Check BITCOINDEEPA_P2P_PRIVATE_KEY_PEM (its public key must be the bot's api.p2p.service_public_key), the server clock and the bot's IP allowlist. (Reported at most hourly.)`,
        )
        .catch(() => undefined);
    }
  }

  /** The wallet summary caches the bot balance; both sides just changed */
  private async clearWalletCaches(
    senderId: string,
    recipientId: number,
  ): Promise<void> {
    await this.redis.del(CacheKeys.transaction.dcaSummary(senderId));
    await this.redis.del(CacheKeys.transaction.dcaSummary(String(recipientId)));
  }
}

function unreachable(purpose: P2pPurpose): HttpException {
  return purpose === 'spend'
    ? new HttpException(
        {
          code: 'outcome_unknown',
          message:
            "We couldn't confirm this payment. Check again: retrying it is safe and won't send twice.",
        },
        HttpStatus.BAD_GATEWAY,
      )
    : new HttpException(
        {
          code: 'p2p_unavailable',
          message: 'Sending sats is not available right now. Try again later.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
}
