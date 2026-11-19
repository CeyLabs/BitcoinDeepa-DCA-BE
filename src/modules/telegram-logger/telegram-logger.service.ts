import { Injectable, Logger } from '@nestjs/common';
import type { JwtPayload } from '../auth/auth.service';
import { Package } from '../package/package.service';
import { escapeHtml } from '../../common/escape-html';

export interface TgMessage {
  id: number | null;
  text: string;
}

/**
 * Telegram allows about 20 messages a minute in a group. Routine logs stop a
 * little below that; alerts may use the rest, so a burst of logs can't crowd
 * them out.
 */
const ROUTINE_MESSAGES_PER_MINUTE = 15;
const ALL_MESSAGES_PER_MINUTE = 19;
/** A 429 without retry_after (body or header): pause this long */
const DEFAULT_RETRY_AFTER_SECONDS = 30;
/** Alerts held while rate limited, sent when the pause ends */
const MAX_QUEUED_ALERTS = 20;

/** A log-group call: its result, or whether it failed only because of rate limits */
type CallResult =
  | { ok: true; result: { message_id?: number } | true }
  | { ok: false; limited: boolean };

type LogGroupMethod = 'sendMessage' | 'editMessageText' | 'setMessageReaction';

@Injectable()
export class TelegramLoggerService {
  private readonly logger = new Logger(TelegramLoggerService.name);
  private readonly botToken: string | undefined;
  private readonly logGroupId: string | undefined;
  private readonly logTopicId: string | undefined;
  /** Telegram's 429 retry_after: nothing goes to the group until then */
  private blockedUntil = 0;
  private droppedWhileLimited = 0;
  private recentSends: number[] = [];
  private warnedNotConfigured = false;
  private queuedAlerts: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** A drain is sending the queue: no second one may start */
  private draining = false;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.logGroupId = process.env.LOG_GROUP_ID;
    this.logTopicId = process.env.LOG_TOPIC_ID;
  }

  private formatUsername(user: JwtPayload): string {
    return user.username ? `@${user.username}` : 'Unknown';
  }

  async logNewTransaction(
    payhereId: string,
    amount: string,
    telegramId: string,
    status: string,
    oneTime = false,
  ): Promise<TgMessage | null> {
    const message =
      `Action: <b>${oneTime ? 'New One-time Buy #BUY' : 'New Transaction'}</b>\n` +
      `User ID: <b>#UID${telegramId}</b>\n` +
      `Transaction ID: <b>#TRX${payhereId}</b>\n` +
      `Amount: <b>${amount} LKR</b>\n` +
      `Status: <b>${status}</b>`;
    return await this.sendMessage(message);
  }

  async logSettlement(
    payhereId: string,
    satoshis: number,
    telegramId: string,
    attemptNumber: number,
  ): Promise<TgMessage | null> {
    const message =
      `Action: <b>Settlement Attempt</b>\n` +
      `User ID: <b>#UID${telegramId}</b>\n` +
      `Transaction ID: <b>#TRX${payhereId}</b>\n` +
      `Satoshis: <b>${satoshis.toLocaleString()}</b>\n` +
      `Attempt: <b>#${attemptNumber}</b>`;
    return await this.sendMessage(message);
  }

  async logSubscriptionCreated(
    subscriptionId: string,
    userId: string,
    _package: Package,
  ): Promise<void> {
    const message =
      `Action: <b>New Subscription</b>\n` +
      `User ID: <b>#UID${userId}</b>\n` +
      `Subscription ID: <b>#SUB${subscriptionId}</b>\n` +
      `Package: <b>${_package.name}</b>\n` +
      `Amount: <b>${_package.amount} LKR</b>`;
    await this.sendMessage(message, true);
  }

  /**
   * Something that needs a human to look at it (fraud signal, manual fix).
   * `text` is plain text: it is escaped, since an error message containing
   * `<` or `&` would make Telegram reject the whole (HTML) alert.
   */
  async logAlert(source: string, text: string): Promise<void> {
    const message = `⚠️ <b>ALERT (${escapeHtml(source)})</b>\n${escapeHtml(text)}`;
    if (!this.isConfigured()) {
      this.logger.error(`ALERT (${source}): ${text}`);
      return;
    }
    // Earlier alerts are still waiting: go behind them, so alerts arrive in
    // order and new ones don't use up the slots the queue is waiting for
    const outcome =
      this.queuedAlerts.length > 0
        ? { ok: false, limited: true }
        : await this.callLogGroup(
            'sendMessage',
            { text: message, parse_mode: 'HTML' },
            true,
          );
    if (outcome.ok) return;
    // Never lose an alert silently: it's always in the app log, and when only
    // rate limits stopped it, it's sent once the pause ends
    if (outcome.limited && this.queueAlert(message)) {
      this.logger.error(
        `ALERT (${source}) delayed by Telegram rate limits, queued: ${text}`,
      );
    } else {
      this.logger.error(`ALERT (${source}) not sent to Telegram: ${text}`);
    }
  }

  /** Hold an alert until the rate limit pause ends. False when the queue is full. */
  private queueAlert(message: string): boolean {
    if (this.queuedAlerts.length >= MAX_QUEUED_ALERTS) return false;
    this.queuedAlerts.push(message);
    this.scheduleAlertFlush();
    return true;
  }

  private scheduleAlertFlush(): void {
    // A running drain schedules the next one itself when it ends
    if (this.flushTimer || this.draining || this.queuedAlerts.length === 0) {
      return;
    }
    // After the 429 pause, or after the per-minute window frees a slot
    const delay = Math.max(this.blockedUntil - Date.now(), 0) + 1_000;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushAlerts();
    }, delay);
    this.flushTimer.unref?.();
  }

  /** Send queued alerts in order; stop (and reschedule) at the first limit. */
  async flushAlerts(): Promise<void> {
    // Two drains at once would both send the queue's head
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queuedAlerts.length > 0) {
        const outcome = await this.callLogGroup(
          'sendMessage',
          { text: this.queuedAlerts[0], parse_mode: 'HTML' },
          true,
        );
        // Limited: the head stays queued and is retried by the next drain
        if (!outcome.ok && outcome.limited) break;
        // Sent, or failed for another reason (already in the app log): next
        this.queuedAlerts.shift();
      }
    } finally {
      this.draining = false;
    }
    this.scheduleAlertFlush();
  }

  /**
   * Direct message to a user through the bot (best effort; never throws).
   * `text` is HTML - escape user-supplied parts with escapeHtml().
   */
  async notifyUser(telegramId: string, text: string): Promise<boolean> {
    if (!this.botToken) return false;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramId,
            text,
            parse_mode: 'HTML',
          }),
        },
      );
      if (!response.ok) {
        this.logger.warn(
          `Telegram message to user ${telegramId} failed (HTTP ${response.status})`,
        );
      }
      return response.ok;
    } catch (error) {
      this.logger.warn(
        `Telegram message to user ${telegramId} failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  async logGenericAction(
    action: string,
    user: JwtPayload,
  ): Promise<TgMessage | null> {
    const message =
      `Action: <b>${action}</b>\n` +
      `Username: <b>${this.formatUsername(user)}</b>\n` +
      `User ID: <b>#UID${user.id}</b>`;
    return await this.sendMessage(message);
  }

  /**
   * Post "Action: <action>" to the log group, run `fn`, and react to the
   * message once `fn` succeeds. `fn` gets the message so it can append to it.
   */
  async trackAction<T>(
    action: string,
    user: JwtPayload,
    fn: (message: TgMessage | null) => Promise<T>,
  ): Promise<T> {
    const message = await this.logGenericAction(action, user);
    const result = await fn(message);
    await this.setMessageReaction(message);
    return result;
  }

  async appendToMessage(
    message: TgMessage | null,
    appendText: string,
  ): Promise<void> {
    // No message: the original send was skipped or failed - nothing to edit
    if (!this.isConfigured() || !message?.id) return;
    const text = `${message.text}\n${appendText}`;
    const outcome = await this.callLogGroup('editMessageText', {
      message_id: message.id.toString(),
      text,
      parse_mode: 'HTML',
    });
    if (outcome.ok) message.text = text;
  }

  async setMessageReaction(message: TgMessage | null): Promise<void> {
    // No message: the original send was skipped or failed - nothing to react to
    if (!this.isConfigured() || !message?.id) return;
    await this.callLogGroup('setMessageReaction', {
      message_id: message.id.toString(),
      reaction: [{ type: 'emoji', emoji: '👍' }],
      is_big: true,
    });
  }

  /** Bot token and log group set; warns once (not on every log) when not. */
  private isConfigured(): boolean {
    if (this.botToken && this.logGroupId) return true;
    if (!this.warnedNotConfigured) {
      this.warnedNotConfigured = true;
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN or LOG_GROUP_ID not configured: Telegram ops logs are off',
      );
    }
    return false;
  }

  /**
   * Whether the group may get another call now. Honors Telegram's 429
   * retry_after, and keeps under its ~20/min group limit itself. Every call
   * counts (edits and reactions too: Telegram limits those per group as
   * well); only alerts may go past the routine cap, so a burst of logs and
   * 👍 reactions can't use up the alerts' headroom or earn a 429 that would
   * pause them. Skipped messages are counted and reported in one line when
   * sending resumes.
   */
  private mayPost(method: LogGroupMethod, priority: boolean): boolean {
    const now = Date.now();
    this.recentSends = this.recentSends.filter((t) => now - t < 60_000);
    const cap =
      priority && method === 'sendMessage'
        ? ALL_MESSAGES_PER_MINUTE
        : ROUTINE_MESSAGES_PER_MINUTE;
    if (now < this.blockedUntil || this.recentSends.length >= cap) {
      if (method === 'sendMessage') this.droppedWhileLimited++;
      return false;
    }
    if (this.droppedWhileLimited > 0) {
      this.logger.warn(
        `Telegram log group: ${this.droppedWhileLimited} message(s) skipped while rate limited`,
      );
      this.droppedWhileLimited = 0;
    }
    this.recentSends.push(now);
    return true;
  }

  /**
   * One call to the Bot API in the log group (topic added). Returns the
   * response's `result`, or null on any failure - logged in one line, never
   * the whole response/error object.
   */
  private async callLogGroup(
    method: LogGroupMethod,
    payload: Record<string, unknown>,
    priority = false,
  ): Promise<CallResult> {
    if (!this.mayPost(method, priority)) return { ok: false, limited: true };
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.logGroupId,
            ...(this.logTopicId && { message_thread_id: this.logTopicId }),
            ...payload,
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: { message_id?: number } | true;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (response.ok && data.ok !== false) {
        return { ok: true, result: data.result ?? true };
      }

      if (response.status === 429) {
        // retry_after from the body, else the Retry-After header, else a default
        const header = Number(response.headers?.get?.('retry-after'));
        const retryAfter =
          data.parameters?.retry_after ??
          (header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS);
        this.pauseFor(retryAfter);
        return { ok: false, limited: true };
      }
      this.logger.error(
        `Telegram ${method} failed (HTTP ${response.status}): ${data.description ?? 'no description'}`,
      );
      return { ok: false, limited: false };
    } catch (error) {
      this.logger.error(
        `Telegram ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, limited: false };
    }
  }

  /**
   * Pause the group until `seconds` from now. Only ever extends the pause:
   * concurrent 429s (calls already in flight) can't shorten it, and only an
   * extension is logged.
   */
  private pauseFor(seconds: number): void {
    const until = Date.now() + seconds * 1000;
    if (until <= this.blockedUntil) return;
    this.blockedUntil = until;
    this.logger.warn(
      `Telegram rate limited the log group: pausing Telegram logs for ${seconds}s`,
    );
  }

  private async sendMessage(
    text: string,
    addReaction: boolean = false,
    priority: boolean = false,
  ): Promise<TgMessage | null> {
    if (!this.isConfigured()) return null;
    const outcome = await this.callLogGroup(
      'sendMessage',
      { text, parse_mode: 'HTML' },
      priority,
    );
    if (!outcome.ok) return null;
    const { result } = outcome;
    const tgMessage: TgMessage = {
      text,
      id: (result !== true && result.message_id) || null,
    };
    if (addReaction && tgMessage.id) {
      await this.setMessageReaction(tgMessage);
    }
    return tgMessage;
  }
}
