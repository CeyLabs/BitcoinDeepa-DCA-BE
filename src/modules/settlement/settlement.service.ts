import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KnexService } from '../knex/knex.service';
import {
  BitcoinDeepaService,
  type FundTransferResponse,
} from '../bitcoindeepa/bitcoindeepa.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { RedisService } from '../redis/redis.service';
import { errorMessage } from '../../common/error-message';
import { legacyTransferMemo, transferMemo } from './transfer-memo';
import {
  MAX_SETTLEMENT_ATTEMPTS,
  type PurchaseKind,
} from '../transaction/transaction.service';

// The bot expires an approval after 24h; past this, a send still not final is stuck
const APPROVAL_OVERDUE_MS = 25 * 60 * 60_000;

interface UnsettledTransaction {
  payhere_pay_id: string;
  kind: PurchaseKind;
  /** Recurring charges */
  payhere_sub_id: string | null;
  satoshis_purchased: number;
  retry_count: number;
  telegram_id: string;
  /** Why the last send didn't go through (UNKNOWN = may have gone, check the memo first) */
  settlement_failure: string | null;
  /** Null = created by an earlier release: sent with the legacy memo */
  transfer_memo: string | null;
}

/** A send held for approval in Telegram (the bot answered 202) */
interface AwaitingApprovalTransaction {
  payhere_pay_id: string;
  bot_send_id: string;
  satoshis_purchased: number;
  telegram_id: string;
  /** When the send that got the 202 was made */
  last_retry_at: Date | null;
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
    private readonly telegramLogger: TelegramLoggerService,
    private readonly redisService: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async retryUnsettledTransactions() {
    if (!this.bitcoinDeepaService.isConfigured()) {
      return;
    }

    try {
      // Backoff is filtered in SQL: retry n waits 2^n minutes after the last
      // attempt, so rows still in backoff are never loaded (or logged).
      const unsettledTransactions: UnsettledTransaction[] =
        await this.knexService
          .knex('transaction as t')
          .select(
            't.payhere_pay_id',
            't.kind',
            't.payhere_sub_id',
            't.satoshis_purchased',
            't.retry_count',
            't.settlement_failure',
            't.transfer_memo',
            'u.id as telegram_id',
          )
          .join('user as u', 't.user_id', 'u.id')
          .where('t.status', 'SUCCESS')
          .where('t.settled', false)
          // Held one-time buys wait for a human (POST /transaction/release-hold)
          .whereNull('t.hold_reason')
          // Sends awaiting approval are followed by pollAwaitingApprovals
          .whereNull('t.bot_send_id')
          .whereNotNull('t.satoshis_purchased')
          .whereNotNull('t.btc_price_at_purchase')
          .where('t.retry_count', '<', MAX_SETTLEMENT_ATTEMPTS)
          .where((qb) => {
            void qb
              .whereNull('t.last_retry_at')
              .orWhereRaw(
                "t.last_retry_at + (power(2, t.retry_count) * interval '1 minute') <= now()",
              );
          });

      for (const transaction of unsettledTransactions) {
        await this.tryTransactionSettlement(transaction);
      }
    } catch (error) {
      this.logger.error(
        `Error during settlement retry process: ${errorMessage(error)}`,
      );
    }
  }

  private async tryTransactionSettlement(transaction: UnsettledTransaction) {
    const {
      payhere_pay_id,
      telegram_id,
      satoshis_purchased,
      retry_count = 0,
    } = transaction;
    const currentRetryCount = retry_count + 1;

    // Atomically claim the row (FOR UPDATE SKIP LOCKED + retry_count check)
    // so concurrent instances don't send the same transfer twice. The row is
    // re-checked against everything that takes it out of the normal retry
    // loop since the snapshot was read: a tick can run long (95s /send), and
    // meanwhile another tick may have parked it for approval, or a human held it.
    const trx = await this.knexService.knex.transaction();
    try {
      const locked = await trx('transaction')
        .where('payhere_pay_id', payhere_pay_id)
        .where('settled', false)
        .where('status', 'SUCCESS')
        .where('retry_count', retry_count)
        .whereNull('bot_send_id')
        .whereNull('hold_reason')
        .forUpdate()
        .skipLocked()
        .first();

      if (!locked) {
        await trx.rollback();
        return;
      }

      // settlement_failure is cleared while the attempt is in flight (the
      // snapshot still has it for the memo check below), so the bot's deposit
      // callback can't reset a row whose send is running
      await trx('transaction')
        .update({
          retry_count: currentRetryCount,
          last_retry_at: new Date(),
          settlement_failure: null,
        })
        .where('payhere_pay_id', payhere_pay_id);
      await trx.commit();
    } catch (error) {
      if (!trx.isCompleted()) {
        await trx.rollback().catch(() => undefined);
      }
      this.logger.error(
        `Failed to claim transaction ${payhere_pay_id} for settlement: ${errorMessage(error)}`,
      );
      return;
    }

    try {
      const memo = await this.memoFor(transaction);
      const mayHaveGoneThrough =
        SettlementService.mayHaveGoneThrough(transaction);

      // A chargeback that arrived since the claim was told "it will not be
      // settled": keep that true.
      const current = await this.knexService
        .knex('transaction')
        .select('status', 'settled', 'hold_reason')
        .where('payhere_pay_id', payhere_pay_id)
        .first<{
          status: string;
          settled: boolean;
          hold_reason: string | null;
        }>();
      if (
        !current ||
        current.status !== 'SUCCESS' ||
        current.settled ||
        current.hold_reason
      ) {
        const now = `${current?.status ?? 'gone'}${current?.hold_reason ? ' (held)' : ''}`;
        this.logger.warn(
          `Settlement of ${payhere_pay_id} skipped: it is ${now} now`,
        );
        // Nothing more is sent, but an earlier send with no answer may have
        // gone through, and nothing looks at a charged-back payment again:
        // find out now (markSettled says so if sats went out).
        if (current && !current.settled && mayHaveGoneThrough) {
          const found = await this.bitcoinDeepaService.findSettlementTransfer(
            Number(telegram_id),
            payhere_pay_id,
            satoshis_purchased,
          );
          if (found) {
            await this.markSettled(payhere_pay_id);
          } else {
            // Put back the marker the claim cleared
            await this.knexService
              .knex('transaction')
              .update({ settlement_failure: 'UNKNOWN' })
              .where('payhere_pay_id', payhere_pay_id)
              .where('retry_count', currentRetryCount);
            await this.telegramLogger.logAlert(
              'Settlement',
              `Settlement of ${payhere_pay_id} was skipped (it is ${now} now), but an earlier send of ${satoshis_purchased} sats to user ${telegram_id} got no answer and a transfer with "(Ref: ${payhere_pay_id})" ${found === null ? "couldn't be looked up" : "isn't in their bot history"}. Check the bot before treating it as not sent.`,
            );
          }
        }
        return;
      }

      const logMessage = await this.telegramLogger.logSettlement(
        payhere_pay_id,
        Number(satoshis_purchased),
        telegram_id,
        currentRetryCount,
      );

      // An earlier send may have gone through: look for it first. Not found
      // means resend with the SAME memo - the bot answers "already completed"
      // if it did go through.
      if (mayHaveGoneThrough) {
        const found = await this.bitcoinDeepaService.findSettlementTransfer(
          Number(telegram_id),
          payhere_pay_id,
          satoshis_purchased,
        );
        if (found) {
          await this.markSettled(payhere_pay_id);
          this.logger.log(
            `Settlement for ${payhere_pay_id} had gone through: found "(Ref: ${payhere_pay_id})" in the user's bot history`,
          );
          await this.telegramLogger.setMessageReaction(logMessage);
          return;
        }
        if (found === null && !transaction.settlement_failure) {
          // An attempt whose outcome nobody recorded (the previous release,
          // or a crash mid-send) may have used another memo, which the bot
          // would not dedupe: don't resend blind. Give the attempt back;
          // last_retry_at keeps the backoff.
          await this.knexService
            .knex('transaction')
            .update({ retry_count: retry_count })
            .where('payhere_pay_id', payhere_pay_id)
            .where('retry_count', currentRetryCount);
          this.logger.warn(
            `Settlement of ${payhere_pay_id} postponed: an earlier attempt's outcome is unknown and the bot history can't be read`,
          );
          return;
        }
      }

      const result = await this.bitcoinDeepaService.transferFunds(
        satoshis_purchased,
        telegram_id,
        memo,
      );

      if (result.success || result.already_completed) {
        await this.markSettled(payhere_pay_id);
        this.logger.log(
          result.already_completed
            ? `Settlement for ${payhere_pay_id} was already completed in a previous attempt`
            : `Settled ${payhere_pay_id}: ${satoshis_purchased} sats to user ${telegram_id} (attempt ${currentRetryCount})`,
        );
        await this.telegramLogger.setMessageReaction(logMessage);
        return;
      }

      if (result.awaiting_approval_id) {
        // Not a failed attempt: give it back and let pollAwaitingApprovals
        // follow the approval. Safe from stale ticks: the claim skips rows
        // with a bot_send_id. Guarded on our own attempt so a stale writer
        // can't overwrite newer state.
        await this.knexService
          .knex('transaction')
          .update({
            bot_send_id: result.awaiting_approval_id,
            settlement_failure: null,
            retry_count: retry_count,
          })
          .where('payhere_pay_id', payhere_pay_id)
          .where('retry_count', currentRetryCount);
        await this.telegramLogger.logAlert(
          'Settlement',
          `Settlement of ${payhere_pay_id} (${satoshis_purchased} sats to user ${telegram_id}) is waiting for approval in the bot (transaction ${result.awaiting_approval_id}). It settles once approved.`,
        );
        return;
      }

      await this.recordFailure(payhere_pay_id, currentRetryCount, result);
      if (result.failure === 'AUTH') {
        await this.alertAuthFailure(result);
      }

      if (currentRetryCount >= MAX_SETTLEMENT_ATTEMPTS) {
        const alert = `Settlement of ${payhere_pay_id} permanently failed after ${currentRetryCount} attempts: ${result.message}`;
        this.logger.error(alert);
        await this.telegramLogger.logAlert('Settlement', alert);
      } else {
        this.logger.warn(
          `Settlement of ${payhere_pay_id} failed (attempt ${currentRetryCount}/${MAX_SETTLEMENT_ATTEMPTS}): ${result.message}. Next retry in ${Math.pow(2, currentRetryCount)} minutes.`,
        );
      }
    } catch (error) {
      // retry_count is already incremented, so the backoff still applies
      this.logger.error(
        `Settlement error for ${payhere_pay_id}: ${errorMessage(error)}`,
      );
      if (currentRetryCount >= MAX_SETTLEMENT_ATTEMPTS) {
        await this.telegramLogger
          .logAlert(
            'Settlement',
            `Settlement of ${payhere_pay_id} stopped after ${currentRetryCount} attempts: ${errorMessage(error)}`,
          )
          .catch(() => undefined);
      }
    }
  }

  /**
   * The sats are with the member. If a chargeback arrived while they were
   * being sent (too late to stop it), its own alert said the payment would
   * not be settled: correct that.
   */
  private async markSettled(payhere_pay_id: string): Promise<void> {
    const [row] = await this.knexService
      .knex('transaction')
      .update({ settled: true, settlement_failure: null, bot_send_id: null })
      .where('payhere_pay_id', payhere_pay_id)
      .returning<
        {
          status: string;
          satoshis_purchased: string | number;
          user_id: string | null;
        }[]
      >(['status', 'satoshis_purchased', 'user_id']);
    if (row?.status === 'CHARGEBACK') {
      const alert = `CHARGEBACK on ${payhere_pay_id} arrived while it was being settled: ${row.satoshis_purchased} sats were sent to user ${row.user_id} - manual reversal needed.`;
      this.logger.error(alert);
      await this.telegramLogger.logAlert('Settlement', alert);
    }
  }

  /**
   * Remember why the send failed (LOW_BALANCE rows are retried by the bot's
   * deposit callback). Only for our own attempt, so a stale writer can't
   * overwrite a newer attempt's state.
   */
  private async recordFailure(
    payhere_pay_id: string,
    attempt: number,
    result: FundTransferResponse,
  ): Promise<void> {
    await this.knexService
      .knex('transaction')
      .update({ settlement_failure: result.failure ?? 'REJECTED' })
      .where('payhere_pay_id', payhere_pay_id)
      .where('retry_count', attempt);
  }

  /**
   * 401/403 from the bot is a key, wallet id, clock or IP problem: every
   * payout fails until someone fixes the config, so say so at once (at most
   * hourly).
   */
  private async alertAuthFailure(result: FundTransferResponse): Promise<void> {
    if (
      await this.redisService.setIfAbsent('dca:alert:bot-auth-failed', 60 * 60)
    ) {
      await this.telegramLogger
        .logAlert(
          'Settlement',
          `The BitcoinDeepa bot rejected our signed request: ${result.message}. ` +
            `Check BITCOINDEEPA_WALLET_ID, BITCOINDEEPA_PRIVATE_KEY_PEM (its public key must be configured on the bot), the server clock and the bot's IP allowlist. (Reported at most hourly.)`,
        )
        .catch(() => undefined);
    }
  }

  /**
   * Follow sends the bot held for approval in Telegram. Executed: settled.
   * Rejected/expired (24h): nothing was sent - stop and ask a human, since
   * resending would just ask for approval again. An id the bot doesn't know
   * (404) stops too, as an unknown outcome: a reset first checks the user's
   * bot history for the memo. One that can't be read past the bot's 24h
   * expiry is reported (once a day) instead of being skipped silently.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async pollAwaitingApprovals() {
    if (!this.bitcoinDeepaService.isConfigured()) return;

    let rows: AwaitingApprovalTransaction[];
    try {
      rows = await this.knexService
        .knex('transaction as t')
        .select<
          AwaitingApprovalTransaction[]
        >('t.payhere_pay_id', 't.bot_send_id', 't.satoshis_purchased', 't.last_retry_at', 'u.id as telegram_id')
        .join('user as u', 't.user_id', 'u.id')
        .whereNotNull('t.bot_send_id')
        .where('t.settled', false)
        .where('t.status', 'SUCCESS');
    } catch (error) {
      this.logger.error(
        `Error loading sends awaiting approval: ${errorMessage(error)}`,
      );
      return;
    }

    for (const row of rows) {
      const status = await this.bitcoinDeepaService.getSendStatus(
        row.bot_send_id,
      );
      const what = `${row.payhere_pay_id} (${row.satoshis_purchased} sats to user ${row.telegram_id})`;

      if (status === 'NOT_FOUND') {
        await this.stopAwaitingApproval(
          row,
          'UNKNOWN',
          `Settlement of ${what}: the bot doesn't know send ${row.bot_send_id}. Retries stopped - check the bot, then POST /transaction/reset-retry-count/${row.payhere_pay_id} (a reset first looks for the memo in the user's bot history).`,
        );
        continue;
      }
      if (!status) {
        await this.alertIfApprovalOverdue(row, what);
        continue; // unreadable now: try next minute
      }

      if (status.status === 'executed') {
        await this.markSettled(row.payhere_pay_id);
        this.logger.log(
          `Settled ${row.payhere_pay_id}: approved send ${row.bot_send_id} executed`,
        );
        continue;
      }
      if (status.status === 'rejected' || status.status === 'expired') {
        await this.stopAwaitingApproval(
          row,
          'APPROVAL_REJECTED',
          `Settlement of ${what}: the bot send ${row.bot_send_id} was ${status.status}, nothing was sent. Retries stopped - decide, then POST /transaction/reset-retry-count/${row.payhere_pay_id} to send again.`,
        );
        continue;
      }
      // pending / approved / in_flight: still going
      await this.alertIfApprovalOverdue(row, what);
    }
  }

  /**
   * Leave the approval state and stop retrying. Alerts only when this
   * instance made the change (another instance may have polled the same row).
   */
  private async stopAwaitingApproval(
    row: AwaitingApprovalTransaction,
    failure: 'APPROVAL_REJECTED' | 'UNKNOWN',
    alert: string,
  ): Promise<void> {
    const updated = await this.knexService
      .knex('transaction')
      .update({
        bot_send_id: null,
        settlement_failure: failure,
        retry_count: MAX_SETTLEMENT_ATTEMPTS,
      })
      .where('payhere_pay_id', row.payhere_pay_id)
      .where('bot_send_id', row.bot_send_id)
      .where('settled', false);
    if (!updated) return;
    this.logger.error(alert);
    await this.telegramLogger
      .logAlert('Settlement', alert)
      .catch(() => undefined);
  }

  /** The bot expires approvals after 24h: still waiting after that means something is stuck. */
  private async alertIfApprovalOverdue(
    row: AwaitingApprovalTransaction,
    what: string,
  ): Promise<void> {
    const sentAt = row.last_retry_at
      ? new Date(row.last_retry_at).getTime()
      : 0;
    if (Date.now() - sentAt < APPROVAL_OVERDUE_MS) return;
    if (
      await this.redisService.setIfAbsent(
        `dca:alert:approval-overdue:${row.payhere_pay_id}`,
        24 * 60 * 60,
      )
    ) {
      await this.telegramLogger
        .logAlert(
          'Settlement',
          `Settlement of ${what} has waited over 25h for bot approval ${row.bot_send_id} and its status isn't final. Check it in the bot. (Reported once a day.)`,
        )
        .catch(() => undefined);
    }
  }

  /** The memo a new payment is created with (see transfer-memo.ts) */
  static transferMemo(
    payhere_pay_id: string,
    kind: PurchaseKind = 'RECURRING',
  ): string {
    return transferMemo(payhere_pay_id, kind);
  }

  /**
   * The memo this payment is sent with: the one stored when it was created,
   * or, for a payment created by an earlier release (no stored memo), the
   * memo that release used, so a send it already made is still recognised by
   * the bot as "already completed". A failed package lookup throws: guessing
   * the legacy memo wrong could pay twice, so the attempt is not made.
   */
  private async memoFor(transaction: UnsettledTransaction): Promise<string> {
    if (transaction.transfer_memo) return transaction.transfer_memo;
    if (transaction.kind === 'ONE_TIME' || !transaction.payhere_sub_id) {
      // Only this release creates one-time buys, and it always stores a memo
      return transferMemo(transaction.payhere_pay_id, transaction.kind);
    }
    const row = await this.knexService
      .knex('subscription as s')
      .select('p.name as package_name')
      .join('package as p', 's.package_id', 'p.id')
      .where('s.payhere_sub_id', transaction.payhere_sub_id)
      .first<{ package_name: string | null } | undefined>();
    return legacyTransferMemo(transaction.payhere_pay_id, row?.package_name);
  }

  /**
   * Whether an earlier send may have gone through, so the bot history is
   * checked before sending. UNKNOWN is recorded by this release (timeout or
   * 5xx). An attempt with no recorded outcome counts too: the previous
   * release recorded none and gave up on /send after 10s (it also settles
   * this release's rows while both run during a deploy, with its own memo),
   * and a crash mid-send leaves none.
   */
  private static mayHaveGoneThrough(
    transaction: UnsettledTransaction,
  ): boolean {
    return (
      transaction.settlement_failure === 'UNKNOWN' ||
      (!transaction.settlement_failure && (transaction.retry_count ?? 0) > 0)
    );
  }
}
