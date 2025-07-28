import { Injectable, Logger } from '@nestjs/common';
import { JwtPayload } from 'jsonwebtoken';
import { Package } from '../package/package.service';

interface TgMessage {
  id: number | null;
  text: string;
}

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

  async logNewTransaction(
    payhereId: string,
    amount: string,
    telegramId: string,
    status: string,
  ): Promise<TgMessage | null> {
    const message =
      `Action: <b>New Transaction</b>\n` +
      `User ID: <b>#ID${telegramId}</b>\n` +
      `Transaction ID: <b>#PH${payhereId}</b>\n` +
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
      `User ID: <b>#ID${telegramId}</b>\n` +
      `Transaction ID: <b>#PH${payhereId}</b>\n` +
      `Satoshis: <b>${satoshis.toLocaleString()}</b>\n` +
      `Attempt #: <b>${attemptNumber}</b>`;
    return await this.sendMessage(message);
  }

  async logSubscriptionCreated(
    subscriptionId: string,
    userId: string,
    _package: Package,
  ): Promise<void> {
    const message =
      `Action: <b>New Subscription</b>\n` +
      `User ID: <b>#ID${userId}</b>\n` +
      `Subscription ID: <b>#SUB${subscriptionId}</b>\n` +
      `Package: <b>${_package.name}</b>\n` +
      `Amount: <b>${_package.amount} LKR</b>`;
    await this.sendMessage(message, true);
  }

  async logGenericAction(action: string, user: JwtPayload): Promise<TgMessage | null> {
    const message =
      `Action: <b>${action}</b>\n` +
      `Username: <b>${this.formatUsername(user)}</b>\n` +
      `User ID: <b>#ID${user.id}</b>`;
    return await this.sendMessage(message);
  }

  async appendToMessage(message: TgMessage | null, appendText: string): Promise<void> {
    if (!this.botToken || !this.logGroupId || !message || !message.id) {
      this.logger.warn(
        'Bot token, log group ID, or message ID not provided, skipping message append',
      );
      return;
    }

    try {
      const editUrl = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
      const editPayload: any = {
        chat_id: this.logGroupId,
        message_id: message.id.toString(),
        text: `${message.text}\n${appendText}`,
        parse_mode: 'HTML',
      };

      if (this.logTopicId) {
        editPayload.message_thread_id = this.logTopicId;
      }

      const response = await fetch(editUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(editPayload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        this.logger.error('Failed to append to Telegram message:', errorData);
      } else {
        // Update the message text in the TgMessage object
        message.text = `${message.text}\n${appendText}`;
      }
    } catch (error) {
      this.logger.error('Error appending to Telegram message:', error);
    }
  }

  async setMessageReaction(message: TgMessage | null): Promise<void> {
    if (!this.botToken || !this.logGroupId || !message || !message.id) {
      this.logger.warn(
        'Bot token or log group ID not configured, skipping Telegram reaction',
      );
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/setMessageReaction`;
      const reactionPayload: any = {
        chat_id: this.logGroupId,
        message_id: message.id.toString(),
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

  private async sendMessage(text: string, addReaction: boolean = false): Promise<TgMessage | null> {
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
      const tgMessage: TgMessage = {
        text,
        id: responseData.result?.message_id || null
      };

      // Add reaction if requested
      if (addReaction && tgMessage.id) {
        await this.setMessageReaction(tgMessage);
      }

      return tgMessage;
    } catch (error) {
      this.logger.error('Error sending Telegram log message:', error);
      return null;
    }
  }
}
