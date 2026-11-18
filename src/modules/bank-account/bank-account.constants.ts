export enum BankAccountStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export const STATEMENT_CONTENT_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const;
export type StatementContentType = keyof typeof STATEMENT_CONTENT_TYPES;
export const STATEMENT_MAX_BYTES = 8 * 1024 * 1024;

export const statementKeyPrefix = (userId: string) =>
  `bank-statements/${userId}/`;
