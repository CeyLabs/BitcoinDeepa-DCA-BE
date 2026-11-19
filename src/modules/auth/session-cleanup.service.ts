import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import { SessionService } from './session.service';
import { errorMessage } from '../../common/error-message';

/** Daily: delete expired sessions and login attempts (one instance per day) */
@Injectable()
export class SessionCleanupService {
  private readonly logger = new Logger(SessionCleanupService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    if (
      !(await this.redis.setIfAbsent(
        `dca:cron:session-cleanup:${day}`,
        23 * 60 * 60,
      ))
    ) {
      return;
    }
    try {
      const { sessions, attempts } = await this.sessions.deleteExpired();
      this.logger.log(
        `Session cleanup: ${sessions} session(s), ${attempts} login attempt(s) deleted`,
      );
    } catch (error) {
      this.logger.error(`Session cleanup failed: ${errorMessage(error)}`);
    }
  }
}
