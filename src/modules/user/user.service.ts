import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { usernameUnavailableReason } from './username';
import { KnexService } from '../knex/knex.service';
import {
  DiditStatusMapping,
  KycStatus,
  KycStatusType,
} from './enums/kyc-status.enum';

const REJECTION_REASONS: Record<string, string> = {
  Expired: 'Verification session expired',
  Abandoned: 'Verification was abandoned by user',
  'Kyc Expired': 'Previous KYC verification has expired',
  'In Review': 'Verification is under manual review',
  Resubmitted: 'Reviewer asked to redo some verification steps',
};

// Once a session has one of these results, a late "Not Started"/"In Progress"
// update for the same session must not overwrite it.
const FINAL_KYC_STATUSES: string[] = [
  KycStatus.APPROVED,
  KycStatus.DECLINED,
  KycStatus.IN_REVIEW,
  KycStatus.EXPIRED,
  KycStatus.ABANDONED,
  KycStatus.KYC_EXPIRED,
];

export interface User {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  kyc_status?: KycStatusType;
  kyc_session_id?: string;
  kyc_verified_at?: Date;
  kyc_rejection_reason?: string;
  /** Name Didit verified from the ID (first/last_name are the Telegram name) */
  kyc_full_name?: string | null;
  /** Seed of the user's DiceBear avatar (the app draws it); null = drawn from the id */
  avatar_seed?: string | null;
  /** The member's Bitcoin Deepa @username (not Telegram's); claimed once, permanent */
  username?: string | null;
}

export interface TelegramProfile {
  id: string;
  first_name: string;
  last_name?: string;
}

export interface ProfileDetails {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
}

export type UserWithCompleteProfile = User & ProfileDetails;

export interface KycStatusUpdate {
  kyc_status: KycStatusType;
  kyc_verified_at?: Date | null;
  kyc_rejection_reason?: string | null;
  kyc_full_name?: string | null;
}

export interface KycStatusInfo {
  status: KycStatusType;
  verified_at?: Date;
  rejection_reason?: string;
  session_id?: string;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly knexService: KnexService) {}

  async upsertTelegramUser(profile: TelegramProfile): Promise<void> {
    await this.knexService
      .knex('user')
      .insert({
        id: profile.id,
        first_name: profile.first_name,
        last_name: profile.last_name ?? null,
      })
      .onConflict('id')
      .merge({
        first_name: profile.first_name,
        last_name: profile.last_name ?? null,
      })
      // Once the user completes their profile (legal name used for PayHere
      // billing), stop overwriting it with their Telegram display name.
      .whereNull('user.email');
  }

  async updateProfileDetails(
    id: string,
    profile: ProfileDetails,
  ): Promise<void> {
    await this.knexService.knex('user').where('id', id).update(profile);
  }

  async setAvatarSeed(id: string, seed: string): Promise<void> {
    await this.knexService
      .knex('user')
      .where('id', id)
      .update({ avatar_seed: seed });
  }

  /** A member by their (normalized) Bitcoin Deepa username */
  async getUserByUsername(username: string): Promise<User | undefined> {
    return this.knexService.knex<User>('user').where({ username }).first();
  }

  /** null if the (normalized) username can be claimed, else why not */
  async usernameUnavailableReason(username: string): Promise<string | null> {
    const format = usernameUnavailableReason(username, false);
    if (format) return format;
    return usernameUnavailableReason(
      username,
      !!(await this.getUserByUsername(username)),
    );
  }

  /**
   * Claim a username, once: it never changes after this. 409 when the user
   * already has one, or it's reserved or taken (also when someone else
   * claims it at the same moment: the unique index decides).
   */
  async claimUsername(id: string, username: string): Promise<void> {
    const user = await this.getUserOrThrow(id);
    if (user.username) {
      throw new ConflictException(
        `You already have the username @${user.username}`,
      );
    }
    const reason = await this.usernameUnavailableReason(username);
    if (reason) throw new ConflictException(reason);
    try {
      const updated = await this.knexService
        .knex('user')
        .where({ id })
        .whereNull('username')
        .update({ username });
      if (updated === 0) {
        throw new ConflictException('You already have a username');
      }
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('This username is taken');
      }
      throw error;
    }
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.knexService.knex<User>('user').where('id', id).first();
  }

  async getUserOrThrow(id: string): Promise<User> {
    const user = await this.getUserById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async userExists(id: string): Promise<boolean> {
    const user = await this.getUserById(id);
    return !!user;
  }

  isProfileComplete(user: User): user is UserWithCompleteProfile {
    return !!(
      user.email &&
      user.phone &&
      user.address &&
      user.city &&
      user.country
    );
  }

  async updateKycSessionId(userId: string, sessionId: string): Promise<void> {
    await this.knexService.knex('user').where('id', userId).update({
      kyc_session_id: sessionId,
      kyc_status: KycStatus.IN_PROGRESS,
    });
  }

  /**
   * Save a Didit verification result (from the webhook, or read back from
   * Didit when the webhook was missed). Returns the stored status, or null
   * when the update was ignored.
   */
  async applyDiditResult(
    userId: string,
    currentStatus: string | undefined,
    didit: {
      status: string;
      failure_reason?: string | null;
      /** Name read from the ID; kept on approval, cleared otherwise */
      verifiedName?: string | null;
    },
  ): Promise<KycStatus | null> {
    const dbStatus = DiditStatusMapping[didit.status];
    if (!dbStatus) {
      // e.g. "Awaiting User" (KYB only) - nothing to do for a KYC user
      this.logger.warn(`Ignoring Didit status: ${didit.status}`);
      return null;
    }

    const isProgressUpdate =
      didit.status === 'Not Started' || didit.status === 'In Progress';
    if (
      isProgressUpdate &&
      currentStatus &&
      FINAL_KYC_STATUSES.includes(currentStatus)
    ) {
      this.logger.warn(
        `Ignoring late "${didit.status}" update for user ${userId} (already ${currentStatus})`,
      );
      return null;
    }

    const approved = didit.status === 'Approved';
    const rejectionReason = approved
      ? null
      : didit.status === 'Declined'
        ? didit.failure_reason || 'Verification declined'
        : (REJECTION_REASONS[didit.status] ?? null);

    await this.updateKycStatus(userId, {
      kyc_status: dbStatus,
      kyc_verified_at: approved ? new Date() : null,
      kyc_rejection_reason: rejectionReason,
      kyc_full_name: approved ? (didit.verifiedName ?? null) : null,
    });
    if (approved && !didit.verifiedName) {
      this.logger.warn(
        `KYC approved for user ${userId} without a verified name; it is fetched from Didit when needed`,
      );
    }

    this.logger.log(
      `Updated KYC status for user ${userId} to ${dbStatus} (Didit: ${didit.status}${rejectionReason ? `, reason: ${rejectionReason}` : ''})`,
    );
    return dbStatus;
  }

  async updateKycStatus(
    userId: string,
    kycUpdate: KycStatusUpdate,
  ): Promise<void> {
    await this.knexService.knex('user').where('id', userId).update(kycUpdate);
  }

  async getUserByKycSessionId(sessionId: string): Promise<User | undefined> {
    return this.knexService
      .knex<User>('user')
      .where('kyc_session_id', sessionId)
      .first();
  }

  async getKycStatus(userId: string): Promise<KycStatusInfo> {
    return this.toKycStatus(await this.getUserOrThrow(userId));
  }

  toKycStatus(user: User): KycStatusInfo {
    return {
      status: user.kyc_status || KycStatus.NOT_STARTED,
      verified_at: user.kyc_verified_at,
      rejection_reason: user.kyc_rejection_reason,
      session_id: user.kyc_session_id,
    };
  }
}
