import { Transaction } from '../transaction.service';
import { BotTransaction } from '../../bitcoindeepa/bitcoindeepa.service';

export type TransactionSource = 'plan' | 'bot';

export interface UnifiedTransactionItem {
  source: TransactionSource;
  timestamp: string; // ISO-8601, normalized from created_at (Date) or bot's `time` (string)
  plan?: Transaction; // present when source === 'plan'
  bot?: BotTransaction; // present when source === 'bot'
}

export interface TransactionHistoryResponse {
  transactions: UnifiedTransactionItem[];
  current_page: number;
  limit: number;
  has_more: boolean;
  total_count?: number; // sum of both sources; approximate for type=all
  total_pages?: number; // omitted for type=all — a precise number would be misleading
  sources: {
    plan?: { total_count: number; has_more: boolean };
    bot?: { total_count: number; has_more: boolean };
  };
}
