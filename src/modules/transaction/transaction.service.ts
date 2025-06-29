import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { KnexService } from '../knex/knex.service';

export interface PayHereNotificationParams {
  merchant_id: string;
  order_id: string;
  payment_id: string;
  subscription_id: string;
  payhere_amount: string;
  payhere_currency: string;
  status_code: string;
  md5sig: string;
}

type Status = 'SUCCESS' | 'PENDING' | 'CANCELLED' | 'FAILED' | 'CHARGEBACK';

export interface Transaction {
  payhere_pay_id: string;
  payhere_sub_id: string;
  status: Status;
  created_at?: Date;
  updated_at?: Date;
}

interface Subscription {
  user_id: string;
  payhere_sub_id: string;
  // add other fields as needed
}

function md5String(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

@Injectable()
export class TransactionService {
  constructor(private readonly knexService: KnexService) {}

  private readonly logger = new Logger(TransactionService.name);

  async handlePayHereNotification(
    data: PayHereNotificationParams,
  ): Promise<void> {
    const {
      merchant_id,
      order_id,
      payhere_amount,
      payhere_currency,
      status_code,
      md5sig,
      payment_id,
      subscription_id,
    } = data;

    const merchant_secret = String(process.env.PAYHERE_MERCHANT_SECRET);
    const local_md5sig = md5String(
      merchant_id +
        order_id +
        payhere_amount +
        payhere_currency +
        status_code +
        md5String(merchant_secret).toUpperCase(),
    ).toUpperCase();

    // If the calculated signature does not match the one provided by PayHere
    // the notification may have been tampered with. In that case we reject it.
    if (local_md5sig !== md5sig) {
      throw new UnauthorizedException('Md5 verification failed');
    }

    const existingTransaction = await this.knexService
      .knex<Transaction>('transaction')
      .where('payhere_pay_id', payment_id)
      .first();

    // Mapped status
    const status = this.getPayHereStatusMapped(status_code);

    if (existingTransaction) {
      await this.knexService
        .knex('transaction')
        .update({
          status: status,
        })
        .where('payhere_pay_id', payment_id);
      return;
    }

    await this.createTransaction({
      payhere_pay_id: payment_id,
      payhere_sub_id: subscription_id,
      status,
    });
  }

  async createTransaction(transaction: Transaction): Promise<Transaction> {
    const [created] = await this.knexService
      .knex('transaction')
      .insert(transaction)
      .returning('*');
    return created as Transaction;
  }

  private getPayHereStatusMapped(status_code: string): Status {
    const statusMap: Record<string, Status> = {
      '2': 'SUCCESS',
      '0': 'PENDING',
      '-1': 'CANCELLED',
      '-2': 'FAILED',
      '-3': 'CHARGEBACK',
    };

    return statusMap[status_code] ?? 'FAILED';
  }

  async getTransactionsByUserId(user_id: string): Promise<Transaction[]> {
    // Find the user's subscription
    const subscription: Subscription | undefined = await this.knexService
      .knex<Subscription>('subscription')
      .where('user_id', user_id)
      .first();
    if (!subscription || !subscription.payhere_sub_id) {
      return [];
    }
    // Fetch transactions for the subscription
    return this.knexService
      .knex<Transaction>('transaction')
      .where('payhere_sub_id', subscription.payhere_sub_id)
      .orderBy('created_at', 'desc');
  }
}
