import { Injectable } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';

export interface User {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  kyc_status?:
    | 'Not Started'
    | 'In Progress'
    | 'Approved'
    | 'Declined'
    | 'Kyc Expired'
    | 'In Review'
    | 'Expired'
    | 'Abandoned';
  kyc_session_id?: string;
  kyc_verified_at?: Date;
  kyc_rejection_reason?: string;
}

export interface KycStatusUpdate {
  kyc_status:
    | 'Not Started'
    | 'In Progress'
    | 'Approved'
    | 'Declined'
    | 'Kyc Expired'
    | 'In Review'
    | 'Expired'
    | 'Abandoned';
  kyc_verified_at?: Date | null;
  kyc_rejection_reason?: string | null;
}

@Injectable()
export class UserService {
  constructor(private readonly knexService: KnexService) {}

  async createUser(createUserDto: User): Promise<void> {
    return this.knexService.knex('user').insert(createUserDto);
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.knexService.knex<User>('user').where('id', id).first();
  }

  async userExists(id: string): Promise<boolean> {
    const user = await this.getUserById(id);
    return !!user;
  }

  async updateKycSessionId(userId: string, sessionId: string): Promise<void> {
    await this.knexService.knex('user').where('id', userId).update({
      kyc_session_id: sessionId,
      kyc_status: 'In Progress',
    });
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

  async isKycVerified(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    return user?.kyc_status === 'Approved';
  }

  async getKycStatus(userId: string): Promise<{
    status:
      | 'Not Started'
      | 'In Progress'
      | 'Approved'
      | 'Declined'
      | 'Kyc Expired'
      | 'In Review'
      | 'Expired'
      | 'Abandoned';
    verified_at?: Date;
    rejection_reason?: string;
  } | null> {
    const user = await this.getUserById(userId);
    if (!user) {
      return null;
    }

    return {
      status: user.kyc_status || 'Not Started',
      verified_at: user.kyc_verified_at,
      rejection_reason: user.kyc_rejection_reason,
    };
  }
}
