import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  P2pBotClient,
  P2P_KEY_ENV,
  type P2pBotResponse,
  type P2pCaller,
} from './p2p-bot.client';
import type { P2pInitDto, P2pResolveDto, P2pSendDto } from './dto/p2p.dto';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { errorMessage } from '../../common/error-message';
import { UserService } from '../user/user.service';
import {
  maskDisplayName,
  normalizeUsername,
  USERNAME_PATTERN,
  USERNAME_RULE,
} from '../user/username';

const P2P_PATH = '/api/v1/p2p';
/** Creates the user's bot wallet; not under /p2p but signed the same way */
const INIT_PATH = '/api/v1/init';

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

/** Reads may be retried freely; a spend with no answer may have gone through */
type P2pPurpose = 'read' | 'spend';

/**
 * Login waits for the bot's /init at most this long: a slow bot mustn't hold
 * up every Mini App launch (login goes on with walletLinked: false).
 */
export const LOGIN_INIT_TIMEOUT_MS = 3_000;

/** A Telegram login credential: only POST /api/v1/init carries one */
export type P2pLoginCredential = Extract<P2pCaller, { value: string }>;

const asObject = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

/**
 * The P2P relay: a user sends sats from their own bot wallet. The Telegram
 * login is checked once, at login (init, which links the user on the bot for
 * a year); after that our session names the user (X-BDB-User, signed V2 with
 * the P2P key) and we pass the bot's answer through (its messages are written
 * for users). A user the bot hasn't linked (403 login_required) gets our 403
 * relogin_required: logging in again links them. What isn't the user's to
 * fix - our signature, IP allowlist, a bot outage - is mapped:
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
    private readonly redis: RedisService,
    private readonly telegramLogger: TelegramLoggerService,
    private readonly users: UserService,
  ) {}

  async me(userId: string): Promise<P2pResult> {
    return this.call('GET', `${P2P_PATH}/me`, user(userId), 'read');
  }

  /**
   * The login call: forwards the user's fresh Telegram credential (verified
   * by us just before) to the bot's /api/v1/init, which creates their wallet
   * if they never pressed Start (201, created: true; else 200) and links them
   * for X-BDB-User for a year. Called by every login; the credential is not
   * kept. can_message false (new wallets only) means the bot can't message
   * them yet: the app should offer t.me/<bot>?start=...
   */
  async init(
    userId: string,
    credential: P2pLoginCredential,
    dto: P2pInitDto,
  ): Promise<P2pResult> {
    const result = await this.call(
      'POST',
      INIT_PATH,
      credential,
      'read',
      dto.referral_code ? { referral_code: dto.referral_code } : {},
      LOGIN_INIT_TIMEOUT_MS,
    );
    if (result.body.created === true) {
      await this.redis.del(CacheKeys.transaction.dcaSummary(userId));
    }
    return result;
  }

  /**
   * Finds a member by their Bitcoin Deepa @username in our DB (not the bot,
   * and not Telegram usernames). The send then goes to their Telegram id,
   * which is our user id. 404 recipient_not_found, 400 invalid_username /
   * cannot_send_to_self.
   */
  async resolveRecipient(
    userId: string,
    dto: P2pResolveDto,
  ): Promise<P2pResult> {
    const username = normalizeUsername(dto.to) as string;
    if (!USERNAME_PATTERN.test(username)) {
      throw new HttpException(
        { code: 'invalid_username', message: USERNAME_RULE },
        HttpStatus.BAD_REQUEST,
      );
    }
    const user = await this.users.getUserByUsername(username);
    if (!user) {
      throw new HttpException(
        {
          code: 'recipient_not_found',
          message: `No one has @${username} on Bitcoin Deepa`,
        },
        HttpStatus.NOT_FOUND,
      );
    }
    if (user.id === userId) {
      throw new HttpException(
        { code: 'cannot_send_to_self', message: "That's your own username" },
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      status: HttpStatus.OK,
      body: {
        telegram_id: Number(user.id),
        username,
        name: maskDisplayName(
          user.kyc_full_name ||
            [user.first_name, user.last_name].filter(Boolean).join(' '),
        ),
        avatar_seed: user.avatar_seed ?? null,
      },
    };
  }

  async send(userId: string, dto: P2pSendDto): Promise<P2pResult> {
    const result = await this.call(
      'POST',
      `${P2P_PATH}/send`,
      user(userId),
      'spend',
      {
        to_telegram_id: dto.to_telegram_id,
        amount: dto.amount,
        ...(dto.memo ? { memo: dto.memo } : {}),
        idempotency_key: dto.idempotency_key,
      },
    );
    if (result.body.status === 'completed') {
      await this.clearWalletCaches(userId, dto.to_telegram_id);
    }
    return result;
  }

  /**
   * The user pays a collect request (a sale's debit) from the app. Repeats
   * return the same transfer.
   */
  async approveCollect(userId: string, collectId: string): Promise<P2pResult> {
    return this.call(
      'POST',
      `${P2P_PATH}/collect/${encodeURIComponent(collectId)}/approve`,
      user(userId),
      'spend',
      {},
    );
  }

  async transfer(userId: string, id: string): Promise<P2pResult> {
    return this.call(
      'GET',
      `${P2P_PATH}/transfers/${encodeURIComponent(id)}`,
      user(userId),
      'read',
    );
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    caller: P2pCaller,
    purpose: P2pPurpose,
    body?: Record<string, unknown>,
    timeoutMs?: number,
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
        path,
        caller,
        body,
        ...((timeoutMs === undefined ? [] : [timeoutMs]) as [] | [number]),
      );
    } catch (error) {
      this.logger.error(
        `P2P ${method} ${path}: no answer from the bot (${errorMessage(error)})`,
      );
      throw unreachable(purpose);
    }
    return this.mapResponse(method, path, caller, purpose, response);
  }

  private async mapResponse(
    method: string,
    path: string,
    caller: P2pCaller,
    purpose: P2pPurpose,
    { status, body }: P2pBotResponse,
  ): Promise<P2pResult> {
    const data = asObject(body);
    if (status >= 200 && status < 300) return { status, body: data };

    // Not linked on the bot (never logged in through init, or the year ran
    // out): logging in again links them. 403, not 401: our session is fine,
    // and the app treats a 401 as signed out.
    if (status === 403 && data.code === 'login_required') {
      throw new HttpException(
        {
          code: 'relogin_required',
          message: 'Please log in again to use your wallet.',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    const ourConfig =
      (status === 401 && data.code === 'bad_service_signature') ||
      // X-BDB-User missing/bad, or init sent X-BDB-User: our bug, not the user's
      (status === 401 && caller.kind === 'user') ||
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
    // init: the bot refused the Telegram credential we just verified (too
    // old for it, or used twice). Logging in again gives a fresh one.
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
          `P2P sends are failing: ${reason}. Check ${P2P_KEY_ENV} (its public key must be the bot's api.p2p.service_public_key), the server clock and the bot's IP allowlist. (Reported at most hourly.)`,
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

const user = (telegramId: string): P2pCaller => ({ kind: 'user', telegramId });
