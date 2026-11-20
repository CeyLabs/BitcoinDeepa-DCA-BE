import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { CeyPayBank, CeyPayService } from '../ceypay/ceypay.service';
import { R2StorageService } from '../storage/r2-storage.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { type User, UserService } from '../user/user.service';
import { KycStatus } from '../user/enums/kyc-status.enum';
import { DiditService } from '../didit/didit.service';
import { errorMessage } from '../../common/error-message';
import { escapeHtml } from '../../common/escape-html';
// Only the status list: an account can't be removed under a sale in flight
import { IN_FLIGHT_SELL_STATUSES } from '../sell/sell.constants';
import {
  BankAccountStatus,
  STATEMENT_CONTENT_TYPES,
  STATEMENT_MAX_BYTES,
  statementKeyPrefix,
  type StatementContentType,
} from './bank-account.constants';
import { matchAccountName } from './name-match.util';
import { adminAppOrigins } from '../admin/auth/admin-auth.constants';
import type {
  AddBankAccountDto,
  StatementUploadDto,
} from './dto/bank-account.dto';

const BANK_LIST_CACHE_TTL_SECONDS = 60 * 60;

export interface BankAccountRow {
  id: string;
  user_id: string;
  bank_code: number;
  bank_name: string;
  account_number: string;
  account_name: string;
  status: BankAccountStatus;
  name_match_score: string | null;
  statement_key: string;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  ceypay_user_bank_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserBankAccountView {
  id: string;
  bankCode: number;
  bankName: string;
  /** Last 4 digits only */
  accountNumber: string;
  accountName: string;
  status: BankAccountStatus;
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export const maskAccountNumber = (n: string) =>
  n.length <= 4 ? n : `${'•'.repeat(Math.min(n.length - 4, 6))}${n.slice(-4)}`;

const toUserView = (row: BankAccountRow): UserBankAccountView => ({
  id: row.id,
  bankCode: row.bank_code,
  bankName: row.bank_name,
  accountNumber: maskAccountNumber(row.account_number),
  accountName: row.account_name,
  status: row.status,
  rejectionReason: row.rejection_reason,
  createdAt: new Date(row.created_at).toISOString(),
  reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
});

const STATEMENT_KEY_PATTERN =
  /^bank-statements\/[^/]+\/[0-9a-f-]{36}\.(pdf|jpg|png)$/;

/**
 * Users' payout bank accounts. Every new account starts PENDING_REVIEW and
 * only an admin can verify it (statement vs KYC name). Verified accounts are
 * registered with CeyPay at approval time, so payouts can be sent to them.
 */
@Injectable()
export class BankAccountService {
  private readonly logger = new Logger(BankAccountService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly redisService: RedisService,
    private readonly ceyPayService: CeyPayService,
    private readonly storage: R2StorageService,
    private readonly userService: UserService,
    private readonly telegramLogger: TelegramLoggerService,
    private readonly diditService: DiditService,
  ) {}

  /**
   * The name Didit read from the member's ID. Stored when KYC is approved;
   * fetched from Didit (and stored) if it is missing. first_name / last_name
   * are the Telegram profile name, which the member can change, so they are
   * never used to judge whose account this is.
   */
  async verifiedNameFor(user: User): Promise<string | null> {
    if (user.kyc_full_name) return user.kyc_full_name;
    if (!user.kyc_session_id) return null;
    const session = await this.diditService
      .getSession(user.kyc_session_id)
      .catch((error) => {
        this.logger.warn(
          `Could not fetch the verified name for user ${user.id}: ${errorMessage(error)}`,
        );
        return null;
      });
    const name = session?.status === 'Approved' ? session.verifiedName : null;
    if (name) {
      await this.knex('user')
        .where('id', user.id)
        .update({ kyc_full_name: name });
    }
    return name;
  }

  private get knex(): Knex {
    return this.knexService.knex;
  }

  async getBanks(): Promise<CeyPayBank[]> {
    const banks = await this.redisService.getOrSet(
      CacheKeys.sell.banks(),
      BANK_LIST_CACHE_TTL_SECONDS,
      async () => {
        try {
          return await this.ceyPayService.getBanks();
        } catch (error) {
          this.logger.error(`Bank list fetch failed: ${errorMessage(error)}`);
          return null;
        }
      },
    );
    if (!banks) {
      throw new ServiceUnavailableException(
        'Bank list is unavailable, please try again shortly',
      );
    }
    return banks;
  }

  async createStatementUpload(userId: string, dto: StatementUploadDto) {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException('Uploads are not available');
    }
    const ext = STATEMENT_CONTENT_TYPES[dto.contentType];
    const key = `${statementKeyPrefix(userId)}${randomUUID()}.${ext}`;
    const uploadUrl = await this.storage.presignUpload(
      key,
      dto.contentType,
      dto.size,
    );
    return {
      key,
      uploadUrl,
      method: 'PUT' as const,
      headers: { 'Content-Type': dto.contentType },
      maxBytes: STATEMENT_MAX_BYTES,
    };
  }

  async listForUser(userId: string): Promise<UserBankAccountView[]> {
    const rows = await this.knex<BankAccountRow>('user_bank_account')
      .where({ user_id: userId, is_active: true })
      .orderBy('created_at', 'desc');
    return rows.map(toUserView);
  }

  /** The user's active, verified account, or undefined. */
  getVerifiedAccount(
    userId: string,
    db: Knex | Knex.Transaction = this.knex,
  ): Promise<BankAccountRow | undefined> {
    return db<BankAccountRow>('user_bank_account')
      .where({
        user_id: userId,
        is_active: true,
        status: BankAccountStatus.VERIFIED,
      })
      .first();
  }

  async submit(
    userId: string,
    dto: AddBankAccountDto,
  ): Promise<UserBankAccountView> {
    await this.assertStatementUploaded(userId, dto.statementKey);

    const bank = (await this.getBanks()).find((b) => b.code === dto.bankCode);
    if (!bank) throw new BadRequestException('Unknown bank');

    const user = await this.userService.getUserOrThrow(userId);
    const kycName = await this.verifiedNameFor(user);
    if (!kycName) {
      throw new ServiceUnavailableException(
        "We couldn't confirm the name on your verified ID yet. Please try again in a few minutes.",
      );
    }
    const { score } = matchAccountName(dto.accountName, kycName);

    const row = await this.knex.transaction(async (trx) => {
      // Serialize submissions per user
      await trx('user').where('id', userId).forUpdate().first();

      const active = await trx<BankAccountRow>('user_bank_account').where({
        user_id: userId,
        is_active: true,
      });
      if (
        active.some((a) =>
          [
            BankAccountStatus.PENDING_REVIEW,
            BankAccountStatus.VERIFIED,
          ].includes(a.status),
        )
      ) {
        throw new ConflictException(
          'You already have a bank account in review or verified. Remove it before adding another.',
        );
      }
      // A rejected copy of the same account is retired so it can be resubmitted
      const rejectedSame = active.filter(
        (a) =>
          a.bank_code === dto.bankCode &&
          a.account_number === dto.accountNumber,
      );
      if (rejectedSame.length > 0) {
        await trx('user_bank_account')
          .whereIn(
            'id',
            rejectedSame.map((a) => a.id),
          )
          .update({ is_active: false, updated_at: trx.fn.now() });
      }

      const [inserted] = await trx<BankAccountRow>('user_bank_account')
        .insert({
          user_id: userId,
          bank_code: dto.bankCode,
          bank_name: bank.name,
          account_number: dto.accountNumber,
          account_name: dto.accountName,
          status: BankAccountStatus.PENDING_REVIEW,
          name_match_score: String(score),
          statement_key: dto.statementKey,
        })
        .returning('*');
      return inserted;
    });

    const dashboard = (
      process.env.ADMIN_DASHBOARD_URL || adminAppOrigins()[0]
    )?.replace(/\/+$/, '');
    await this.telegramLogger.logAlert(
      'Bank review',
      // plain text: logAlert escapes it
      `New bank account to review\n` +
        `User: #UID${userId} (${kycName})\n` +
        `Account name: ${dto.accountName}\n` +
        `Bank: ${bank.name}\n` +
        `Name match: ${Math.round(score * 100)}%` +
        (dashboard ? `\n${dashboard}/bank-reviews` : ''),
    );

    return toUserView(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.knex.transaction(async (trx) => {
      const row = await trx<BankAccountRow>('user_bank_account')
        .where({ id, user_id: userId, is_active: true })
        .forUpdate()
        .first();
      if (!row) throw new NotFoundException('Bank account not found');

      const inFlight = await trx('sell_order')
        .select('id')
        .where('user_bank_account_id', id)
        .whereIn('status', IN_FLIGHT_SELL_STATUSES)
        .first<{ id: string } | undefined>();
      if (inFlight) {
        throw new ConflictException(
          'This account has a sale in progress. Try again once it finishes.',
        );
      }
      await trx('user_bank_account')
        .where('id', id)
        .update({ is_active: false, updated_at: trx.fn.now() });
    });
  }

  private async assertStatementUploaded(userId: string, key: string) {
    if (
      !key.startsWith(statementKeyPrefix(userId)) ||
      !STATEMENT_KEY_PATTERN.test(key)
    ) {
      throw new BadRequestException('Invalid statement');
    }
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException('Uploads are not available');
    }
    const object = await this.storage.head(key);
    if (!object) {
      throw new BadRequestException('Statement upload not found');
    }
    const type = (object.contentType || '').split(';')[0].trim();
    if (
      object.size <= 0 ||
      object.size > STATEMENT_MAX_BYTES ||
      !(type in STATEMENT_CONTENT_TYPES) ||
      !key.endsWith(`.${STATEMENT_CONTENT_TYPES[type as StatementContentType]}`)
    ) {
      throw new BadRequestException(
        'Statement must be a PDF, JPEG or PNG up to 8 MB',
      );
    }
  }

  // ---- Admin review ----------------------------------------------------

  async statementUrl(id: string): Promise<{ url: string }> {
    const row = await this.knex<BankAccountRow>('user_bank_account')
      .where('id', id)
      .first();
    if (!row) throw new NotFoundException('Bank account not found');
    return { url: await this.storage.presignDownload(row.statement_key) };
  }

  /**
   * Verify an account: register it with CeyPay (aggregator user + bank
   * account), then mark it VERIFIED. The row stays locked during the CeyPay
   * calls so two admins can't register it twice. If CeyPay fails the account
   * stays PENDING_REVIEW.
   */
  async approve(id: string, reviewer: string): Promise<BankAccountRow> {
    const row = await this.knex.transaction(async (trx) => {
      const account = await this.lockPending(trx, id);
      const user = await trx('user')
        .where('id', account.user_id)
        .forUpdate()
        .first<{
          id: string;
          ceypay_user_id: string | null;
          kyc_status: KycStatus;
        }>();
      if (user.kyc_status !== KycStatus.APPROVED) {
        throw new ConflictException(
          `The member's KYC is no longer approved (${user.kyc_status})`,
        );
      }

      try {
        let ceypayUserId = user.ceypay_user_id;
        if (!ceypayUserId) {
          ceypayUserId = (await this.ceyPayService.upsertUser(user.id)).userId;
          await trx('user')
            .where('id', user.id)
            .update({ ceypay_user_id: ceypayUserId });
        }
        const ceypayBank = await this.ceyPayService.addBankAccount(
          ceypayUserId,
          {
            bankCode: account.bank_code,
            accountNumber: account.account_number,
            accountName: account.account_name,
          },
        );

        const [updated] = await trx<BankAccountRow>('user_bank_account')
          .where('id', id)
          .update({
            status: BankAccountStatus.VERIFIED,
            ceypay_user_bank_id: ceypayBank.userBankId,
            reviewed_by: reviewer,
            reviewed_at: trx.fn.now(),
            rejection_reason: null,
            updated_at: trx.fn.now(),
          })
          .returning('*');
        return updated;
      } catch (error) {
        this.logger.error(
          `Registering bank account ${id} with CeyPay failed: ${errorMessage(error)}`,
        );
        throw new BadGatewayException(
          `Could not register the account with CeyPay: ${errorMessage(error)}`,
        );
      }
    });

    await this.telegramLogger.notifyUser(
      row.user_id,
      `✅ <b>Bank account verified</b>\n` +
        `${escapeHtml(row.bank_name)} ${maskAccountNumber(row.account_number)} is ready. You can now receive payouts to it.`,
    );
    this.logger.log(`Bank account ${id} verified by ${reviewer}`);
    return row;
  }

  async reject(
    id: string,
    reason: string,
    reviewer: string,
  ): Promise<BankAccountRow> {
    const row = await this.knex.transaction(async (trx) => {
      await this.lockPending(trx, id);
      const [updated] = await trx<BankAccountRow>('user_bank_account')
        .where('id', id)
        .update({
          status: BankAccountStatus.REJECTED,
          rejection_reason: reason,
          reviewed_by: reviewer,
          reviewed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return updated;
    });

    await this.telegramLogger.notifyUser(
      row.user_id,
      `❌ <b>Bank account not approved</b>\n` +
        `${escapeHtml(row.bank_name)} ${maskAccountNumber(row.account_number)}: ${escapeHtml(reason)}\n` +
        `You can add another account.`,
    );
    this.logger.log(`Bank account ${id} rejected by ${reviewer}: ${reason}`);
    return row;
  }

  private async lockPending(
    trx: Knex.Transaction,
    id: string,
  ): Promise<BankAccountRow> {
    const account = await trx<BankAccountRow>('user_bank_account')
      .where({ id, is_active: true })
      .forUpdate()
      .first();
    if (!account) throw new NotFoundException('Bank account not found');
    if (account.status !== BankAccountStatus.PENDING_REVIEW) {
      throw new ConflictException(
        `Bank account is not pending review (${account.status})`,
      );
    }
    return account;
  }
}
