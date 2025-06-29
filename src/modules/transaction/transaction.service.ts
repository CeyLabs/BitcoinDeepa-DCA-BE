import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { KnexService } from '../knex/knex.service';
import { Subscription } from '../../models/subscription';
import { BitcoinPriceService } from '../bitcoin-price/bitcoin-price.service';

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
  btc_price_at_purchase?: number;
  satoshis_purchased?: number;
  price_currency?: string;
  coingecko_timestamp?: Date;
  created_at?: Date;
  updated_at?: Date;
}

function md5String(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

@Injectable()
export class TransactionService {
  constructor(
    private readonly knexService: KnexService,
    private readonly bitcoinPriceService: BitcoinPriceService,
  ) {}

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
      const updateData: Partial<Transaction> = { status };

      // If transaction is now successful and we don't have Bitcoin data, fetch it
      if (status === 'SUCCESS' && !existingTransaction.satoshis_purchased) {
        const bitcoinData = await this.fetchBitcoinDataForTransaction(
          parseFloat(payhere_amount),
          payhere_currency,
        );
        if (bitcoinData) {
          Object.assign(updateData, bitcoinData);
        }
      }

      await this.knexService
        .knex('transaction')
        .update(updateData)
        .where('payhere_pay_id', payment_id);
      return;
    }

    // Create new transaction with Bitcoin data if successful
    const transactionData: Transaction = {
      payhere_pay_id: payment_id,
      payhere_sub_id: subscription_id,
      status,
    };

    // Only fetch Bitcoin data for successful transactions
    if (status === 'SUCCESS') {
      const bitcoinData = await this.fetchBitcoinDataForTransaction(
        parseFloat(payhere_amount),
        payhere_currency,
      );
      if (bitcoinData) {
        Object.assign(transactionData, bitcoinData);
      }
    }

    await this.createTransaction(transactionData);
  }

  async createTransaction(transaction: Transaction): Promise<Transaction> {
    const result = await this.knexService
      .knex('transaction')
      .insert(transaction)
      .returning('*');
    return result[0] as Transaction;
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

  private async fetchBitcoinDataForTransaction(
    amount: number,
    currency: string,
  ): Promise<{
    btc_price_at_purchase: number;
    satoshis_purchased: number;
    price_currency: string;
    coingecko_timestamp: Date;
  } | null> {
    try {
      // Check if Bitcoin tracking is enabled
      if (process.env.ENABLE_BITCOIN_TRACKING === 'false') {
        this.logger.debug('Bitcoin tracking is disabled');
        return null;
      }

      const bitcoinCalculation =
        await this.bitcoinPriceService.calculateSatoshis(amount, currency);

      if (!bitcoinCalculation) {
        this.logger.warn(
          `Failed to fetch Bitcoin price for ${amount} ${currency}`,
        );
        return null;
      }

      this.logger.log(
        `Bitcoin DCA calculation: ${amount} ${currency} = ${bitcoinCalculation.satoshis} satoshis at ${bitcoinCalculation.btc_price} ${currency}/BTC`,
      );

      return {
        btc_price_at_purchase: bitcoinCalculation.btc_price,
        satoshis_purchased: bitcoinCalculation.satoshis,
        price_currency: bitcoinCalculation.currency,
        coingecko_timestamp: bitcoinCalculation.timestamp,
      };
    } catch (error) {
      this.logger.error('Error fetching Bitcoin data for transaction:', error);
      return null;
    }
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

  async getDCASummaryForUser(user_id: string): Promise<{
    total_transactions: number;
    successful_transactions: number;
    total_satoshis_purchased: number;
    total_amount_spent: number;
    average_btc_price: number;
    currency: string;
    first_purchase_date?: Date;
    last_purchase_date?: Date;
  } | null> {
    try {
      // Find the user's subscription
      const subscription: Subscription | undefined = await this.knexService
        .knex<Subscription>('subscription')
        .where('user_id', user_id)
        .first();

      if (!subscription || !subscription.payhere_sub_id) {
        return null;
      }

      // Get all successful transactions with Bitcoin data
      const transactions = await this.knexService
        .knex<Transaction>('transaction')
        .where('payhere_sub_id', subscription.payhere_sub_id)
        .whereNotNull('satoshis_purchased')
        .where('status', 'SUCCESS');

      if (transactions.length === 0) {
        return {
          total_transactions: 0,
          successful_transactions: 0,
          total_satoshis_purchased: 0,
          total_amount_spent: 0,
          average_btc_price: 0,
          currency: 'LKR',
        };
      }

      const totalSatoshis = transactions.reduce(
        (sum, tx) => sum + (tx.satoshis_purchased || 0),
        0,
      );

      const totalSpent = transactions.reduce(
        (sum, tx) =>
          sum +
          (tx.btc_price_at_purchase
            ? (tx.satoshis_purchased! / 100_000_000) * tx.btc_price_at_purchase
            : 0),
        0,
      );

      const averageBTCPrice =
        totalSpent > 0 && totalSatoshis > 0
          ? totalSpent / (totalSatoshis / 100_000_000)
          : 0;

      const dates = transactions
        .map((tx) => tx.created_at)
        .filter((date) => date)
        .sort();

      return {
        total_transactions: transactions.length,
        successful_transactions: transactions.length,
        total_satoshis_purchased: totalSatoshis,
        total_amount_spent: totalSpent,
        average_btc_price: averageBTCPrice,
        currency: transactions[0]?.price_currency || 'LKR',
        first_purchase_date: dates.length > 0 ? dates[0] : undefined,
        last_purchase_date:
          dates.length > 0 ? dates[dates.length - 1] : undefined,
      };
    } catch (error) {
      this.logger.error('Error calculating DCA summary:', error);
      return null;
    }
  }
}
