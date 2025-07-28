import { Injectable, Logger } from '@nestjs/common';
import { JwtPayload } from 'jsonwebtoken';
import { Package } from '../package/package.service';

@Injectable()
export class TelegramLoggerService {
  private readonly logger = new Logger(TelegramLoggerService.name);
  private readonly botToken: string | undefined;
  private readonly logGroupId: string | undefined;
  private readonly logTopicId: string | undefined;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.logGroupId = process.env.LOG_GROUP_ID;
    this.logTopicId = process.env.LOG_TOPIC_ID;
  }

  private formatUsername(user: JwtPayload): string {
    return user.username ? `@${user.username}` : 'Unknown';
  }

  async logUserRegistration(user: JwtPayload): Promise<void> {
    const message =
      `🟢 New user registered!\n` +
      `Username: <b>${this.formatUsername(user)}</b>\n` +
      `User ID: <b>#ID${user.id}</b>`;
    await this.sendMessage(message);
  }

  async logNewTransaction(
    payhereId: string,
    amount: string,
    telegramId: string,
  ): Promise<void> {
    const message =
      `💰 New transaction!\n` +
      `Transaction: <b>#PH${payhereId}</b>\n` +
      `Amount: <b>${amount} LKR</b>\n` +
      `User ID: <b>#ID${telegramId}</b>`;
    await this.sendMessage(message);
  }

  async logSettlementSuccess(
    payhereId: string,
    satoshis: number,
    telegramId: string,
    attemptNumber: number,
  ): Promise<void> {
    const message =
      `🟢 Settlement successful!\n` +
      `Transaction: <b>#PH${payhereId}</b>\n` +
      `Satoshis: <b>${satoshis.toLocaleString()}</b>\n` +
      `User ID: <b>#ID${telegramId}</b>\n` +
      `Attempt: <b>${attemptNumber}</b>`;
    await this.sendMessage(message);
  }

  async logSubscriptionCancelled(
    subscriptionId: string,
    user: JwtPayload,
  ): Promise<void> {
    const message =
      `🟢 Subscription cancelled!\n` +
      `Subscription: <b>#SUB${subscriptionId}</b>\n` +
      `Username: <b>${this.formatUsername(user)}</b>\n` +
      `User ID: <b>#ID${user.id}</b>`;
    await this.sendMessage(message);
  }

  async logUserAction(action: string, user: JwtPayload): Promise<number | null> {
    const message =
      `📱 Action: <b>${action}</b>\n` +
      `Username: <b>${this.formatUsername(user)}</b>\n` +
      `User ID: <b>#ID${user.id}</b>`;
    return await this.sendMessage(message);
  }

  async logSubscriptionCreated(
    subscriptionId: string,
    user: JwtPayload,
    _package: Package,
  ): Promise<void> {
    const message =
      `🟢 New subscription created!\n` +
      `Subscription: <b>#SUB${subscriptionId}</b>\n` +
      `Username: <b>${this.formatUsername(user)}</b>\n` +
      `User ID: <b>#ID${user.id}</b>\n` +
      `Package: <b>${_package.name}</b>\n` +
      `Amount: <b>${_package.amount} LKR</b>`;
    await this.sendMessage(message);
  }

  async setMessageReaction(messageId: number | null): Promise<void> {
    if (!this.botToken || !this.logGroupId || !messageId) {
      this.logger.warn(
        'Bot token or log group ID not configured, skipping Telegram reaction',
      );
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/setMessageReaction`;
      const reactionPayload: any = {
        chat_id: this.logGroupId,
        message_id: messageId.toString(),
        reaction: [{ type: 'emoji', emoji: '👍' }],
        is_big: true,
      };

      if (this.logTopicId) {
        reactionPayload.message_thread_id = this.logTopicId;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reactionPayload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        this.logger.error('Failed to set Telegram message reaction:', errorData);
      }
    } catch (error) {
      this.logger.error('Error setting Telegram message reaction:', error);
    }
  }

  private async sendMessage(text: string): Promise<number | null> {
    if (!this.botToken || !this.logGroupId) {
      this.logger.warn(
        'Bot token or log group ID not configured, skipping Telegram log',
      );
      return null;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const messagePayload: any = {
        chat_id: this.logGroupId,
        text,
        parse_mode: 'HTML',
      };

      if (this.logTopicId) {
        messagePayload.message_thread_id = this.logTopicId;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messagePayload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        this.logger.error('Failed to send Telegram log message:', errorData);
        return null;
      }

      const responseData = await response.json();
      return responseData.result?.message_id || null;
    } catch (error) {
      this.logger.error('Error sending Telegram log message:', error);
      return null;
    }
  }
}
