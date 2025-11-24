export enum KycStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  APPROVED = 'APPROVED',
  DECLINED = 'DECLINED',
  KYC_EXPIRED = 'KYC_EXPIRED',
  IN_REVIEW = 'IN_REVIEW',
  EXPIRED = 'EXPIRED',
  ABANDONED = 'ABANDONED',
}

// Mapping from Didit's API status values to our database enum values
export const DiditStatusMapping: Record<string, KycStatus> = {
  'Not Started': KycStatus.NOT_STARTED,
  'In Progress': KycStatus.IN_PROGRESS,
  Approved: KycStatus.APPROVED,
  Declined: KycStatus.DECLINED,
  'Kyc Expired': KycStatus.KYC_EXPIRED,
  'In Review': KycStatus.IN_REVIEW,
  Expired: KycStatus.EXPIRED,
  Abandoned: KycStatus.ABANDONED,
};

// Reverse mapping from our database values to Didit's API values
export const DatabaseToDiditMapping: Record<KycStatus, string> = {
  [KycStatus.NOT_STARTED]: 'Not Started',
  [KycStatus.IN_PROGRESS]: 'In Progress',
  [KycStatus.APPROVED]: 'Approved',
  [KycStatus.DECLINED]: 'Declined',
  [KycStatus.KYC_EXPIRED]: 'Kyc Expired',
  [KycStatus.IN_REVIEW]: 'In Review',
  [KycStatus.EXPIRED]: 'Expired',
  [KycStatus.ABANDONED]: 'Abandoned',
};

export type KycStatusType = `${KycStatus}`;
export type DiditStatusType =
  | 'Not Started'
  | 'In Progress'
  | 'Approved'
  | 'Declined'
  | 'Kyc Expired'
  | 'In Review'
  | 'Expired'
  | 'Abandoned';
