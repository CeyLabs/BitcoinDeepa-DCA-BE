import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KnexService } from '../../knex/knex.service';
import type { KycStatus } from '../../user/enums/kyc-status.enum';
import { BankAccountStatus } from '../../bank-account/bank-account.constants';
import { likeEscape, type Page, toPage } from '../common/pagination';
import type { ListBankReviewsQueryDto } from './dto/bank-reviews.dto';

export interface AdminBankReview {
  id: string;
  userId: string;
  /** Name on the member's profile (Telegram / KYC) */
  memberName: string;
  kycStatus: KycStatus;
  accountName: string;
  /** 0..1 match of accountName against memberName; a hint only */
  nameMatchScore: number | null;
  bankCode: number;
  bankName: string;
  accountNumber: string;
  status: BankAccountStatus;
  rejectionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

type Row = {
  id: string;
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  kyc_status: KycStatus;
  account_name: string;
  name_match_score: string | null;
  bank_code: number;
  bank_name: string;
  account_number: string;
  status: BankAccountStatus;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
};

@Injectable()
export class AdminBankReviewsService {
  constructor(private readonly knexService: KnexService) {}

  async list(query: ListBankReviewsQueryDto): Promise<Page<AdminBankReview>> {
    const { page, pageSize, q } = query;
    const status = query.status ?? BankAccountStatus.PENDING_REVIEW;
    const knex = this.knexService.knex;

    const filtered = knex('user_bank_account as b')
      .join('user as u', 'u.id', 'b.user_id')
      .where('b.status', status)
      .modify((qb: Knex.QueryBuilder) => {
        // Rejected accounts the user replaced are hidden; the rest are current
        if (status !== BankAccountStatus.REJECTED)
          qb.where('b.is_active', true);
        if (q) {
          const like = `%${likeEscape(q)}%`;
          qb.where((w) => {
            void w
              .where('u.id', q)
              .orWhereRaw("concat_ws(' ', u.first_name, u.last_name) ilike ?", [
                like,
              ])
              .orWhereILike('b.account_name', like)
              .orWhereILike('b.account_number', like);
          });
        }
      });

    // Pending: oldest first (review queue). Others: most recently reviewed.
    const order =
      status === BankAccountStatus.PENDING_REVIEW
        ? [
            { column: 'b.created_at', order: 'asc' as const },
            { column: 'b.id', order: 'asc' as const },
          ]
        : [
            { column: 'b.reviewed_at', order: 'desc' as const },
            { column: 'b.id', order: 'desc' as const },
          ];

    const [countRow, rows] = await Promise.all([
      filtered.clone().count<{ count: string }[]>('* as count').first(),
      filtered
        .clone()
        .select(
          'b.id',
          'b.user_id',
          'u.first_name',
          'u.last_name',
          'u.kyc_status',
          'b.account_name',
          'b.name_match_score',
          'b.bank_code',
          'b.bank_name',
          'b.account_number',
          'b.status',
          'b.rejection_reason',
          'b.reviewed_by',
          'b.reviewed_at',
          'b.created_at',
        )
        .orderBy(order)
        .offset((page - 1) * pageSize)
        .limit(pageSize) as Promise<Row[]>,
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      memberName: [row.first_name, row.last_name].filter(Boolean).join(' '),
      kycStatus: row.kyc_status,
      accountName: row.account_name,
      nameMatchScore:
        row.name_match_score === null ? null : Number(row.name_match_score),
      bankCode: row.bank_code,
      bankName: row.bank_name,
      accountNumber: row.account_number,
      status: row.status,
      rejectionReason: row.rejection_reason,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at
        ? new Date(row.reviewed_at).toISOString()
        : null,
      createdAt: new Date(row.created_at).toISOString(),
    }));
    return toPage(items, Number(countRow?.count ?? 0), query);
  }

  async pendingCount(): Promise<{ pending: number }> {
    const row = await this.knexService
      .knex('user_bank_account')
      .where({ status: BankAccountStatus.PENDING_REVIEW, is_active: true })
      .count<{ count: string }[]>('* as count')
      .first();
    return { pending: Number(row?.count ?? 0) };
  }
}
