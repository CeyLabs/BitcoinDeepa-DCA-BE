import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { KnexService } from '../knex/knex.service';
import { Subscription } from '../../models/subscription';
import { BitcoinPriceService } from '../bitcoin-price/bitcoin-price.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import Big from 'big.js';

export interface PayHereNotificationParams {
  merchant_id: string;
  order_id: string;
  payment_id: string;
  subscription_id: string;
  payhere_amount: string;
  payhere_currency: string;
  status_code: string;
  md5sig: string;
  custom_1?: string; // user_id
  custom_2?: string; // package_id (if we add it)
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
    private readonly dbLogger: DatabaseLoggerService,
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
      custom_1: user_id,
      custom_2: package_id,
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
      await this.dbLogger.error(`MD5 signature verification failed for payment_id ${payment_id}, order_id ${order_id}: expected ${local_md5sig}, received ${md5sig}`);
      throw new UnauthorizedException('Md5 verification failed');
    }
    
    await this.dbLogger.info(`MD5 signature verified for payment_id ${payment_id}, order_id ${order_id}`);
    
    const status = this.getPayHereStatusMapped(status_code);
    await this.dbLogger.info(`Processing PayHere notification: payment_id=${payment_id}, subscription_id=${subscription_id}, status=${status}, amount=${payhere_amount} ${payhere_currency}`);

    const existingTransaction = await this.knexService
      .knex<Transaction>('transaction')
      .where('payhere_pay_id', payment_id)
      .first();

    if (existingTransaction) {
      await this.dbLogger.info(`Updating existing transaction ${payment_id}: ${existingTransaction.status} → ${status}`);
      
      const updateData: Partial<Transaction> = { status };

      // If transaction is now successful and we don't have Bitcoin data, fetch it
      if (status === 'SUCCESS' && !existingTransaction.satoshis_purchased) {
        await this.dbLogger.info(`Fetching Bitcoin data for successful transaction ${payment_id}`);
        const bitcoinData = await this.fetchBitcoinDataForTransaction(
          parseFloat(payhere_amount),
          payhere_currency,
        );
        if (bitcoinData) {
          Object.assign(updateData, bitcoinData);
          await this.dbLogger.info(`Bitcoin data added to transaction ${payment_id}: ${bitcoinData.satoshis_purchased} sats at ${bitcoinData.btc_price_at_purchase} ${bitcoinData.price_currency}`);
        }
      }

      await this.knexService
        .knex('transaction')
        .update(updateData)
        .where('payhere_pay_id', payment_id);
      
      await this.dbLogger.info(`Transaction ${payment_id} updated successfully`);
      return;
    }

    // Check if subscription exists, create if it doesn't
    await this.ensureSubscriptionExists(subscription_id, user_id, package_id);

    // Create new transaction with Bitcoin data if successful
    await this.dbLogger.info(`Creating new transaction for payment_id ${payment_id}, subscription_id ${subscription_id}, status ${status}`);
    
    const transactionData: Transaction = {
      payhere_pay_id: payment_id,
      payhere_sub_id: subscription_id,
      status,
    };

    // Only fetch Bitcoin data for successful transactions
    if (status === 'SUCCESS') {
      await this.dbLogger.info(`Fetching Bitcoin data for new successful transaction ${payment_id}`);
      const bitcoinData = await this.fetchBitcoinDataForTransaction(
        parseFloat(payhere_amount),
        payhere_currency,
      );
      if (bitcoinData) {
        Object.assign(transactionData, bitcoinData);
        await this.dbLogger.info(`Bitcoin data fetched for new transaction ${payment_id}: ${bitcoinData.satoshis_purchased} sats at ${bitcoinData.btc_price_at_purchase} ${bitcoinData.price_currency}`);
      }
    }

    await this.createTransaction(transactionData);
    await this.dbLogger.info(`New transaction ${payment_id} created successfully`);
  }

  async createTransaction(transaction: Transaction): Promise<Transaction> {
    try {
      const result = await this.knexService
        .knex('transaction')
        .insert(transaction)
        .returning('*');
      
      await this.dbLogger.info(`Transaction inserted into database: ${transaction.payhere_pay_id}`);
      return result[0] as Transaction;
    } catch (error) {
      await this.dbLogger.error(`Failed to insert transaction ${transaction.payhere_pay_id}: ${error.message}`);
      throw error;
    }
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
        await this.dbLogger.info('Bitcoin tracking is disabled - skipping Bitcoin data fetch');
        return null;
      }

      await this.dbLogger.info(`Fetching Bitcoin price for ${amount} ${currency}`);
      const bitcoinCalculation =
        await this.bitcoinPriceService.calculateSatoshis(amount, currency);

      if (!bitcoinCalculation) {
        await this.dbLogger.warn(`Failed to fetch Bitcoin price for ${amount} ${currency} - CoinGecko API may be unavailable`);
        return null;
      }

      await this.dbLogger.info(`Bitcoin DCA calculation: ${amount} ${currency} = ${bitcoinCalculation.satoshis} satoshis at ${bitcoinCalculation.btc_price} ${currency}/BTC`);

      return {
        btc_price_at_purchase: bitcoinCalculation.btc_price,
        satoshis_purchased: bitcoinCalculation.satoshis,
        price_currency: bitcoinCalculation.currency,
        coingecko_timestamp: bitcoinCalculation.timestamp,
      };
    } catch (error) {
      await this.dbLogger.error(`Error fetching Bitcoin data for transaction (${amount} ${currency}): ${error.message}`);
      return null;
    }
  }

  async getTransactionsByUserId(user_id: string): Promise<Transaction[]> {
    // Find all user's subscriptions
    const subscriptions: Subscription[] = await this.knexService
      .knex<Subscription>('subscription')
      .where('user_id', user_id);
      
    if (subscriptions.length === 0) {
      await this.dbLogger.info(`No subscriptions found for user ${user_id} - returning empty transaction list`);
      return [];
    }

    const subscriptionIds = subscriptions.map(sub => sub.payhere_sub_id);
    
    // Fetch transactions for ALL subscriptions
    const transactions = await this.knexService
      .knex<Transaction>('transaction')
      .whereIn('payhere_sub_id', subscriptionIds)
      .orderBy('created_at', 'desc');
    
    await this.dbLogger.info(`Retrieved ${transactions.length} transactions for user ${user_id} across ${subscriptions.length} subscriptions`);
    return transactions;
  }

  async getLatestTransactionForUser(user_id: string): Promise<Transaction | null> {
    try {
      await this.dbLogger.info(`Fetching latest transaction for user ${user_id}`);
      
      // Find user's active subscription
      const activeSubscription: Subscription | undefined = await this.knexService
        .knex<Subscription>('subscription')
        .where('user_id', user_id)
        .where('is_active', true)
        .orderBy('created_at', 'desc')
        .first();
        
      if (!activeSubscription) {
        await this.dbLogger.info(`No active subscription found for user ${user_id} - returning null`);
        return null;
      }

      // Get the latest transaction from the active subscription
      const latestTransaction = await this.knexService
        .knex<Transaction>('transaction')
        .where('payhere_sub_id', activeSubscription.payhere_sub_id)
        .orderBy('created_at', 'desc')
        .first();
      
      if (latestTransaction) {
        await this.dbLogger.info(`Latest transaction found for user ${user_id}: ${latestTransaction.payhere_pay_id} with status ${latestTransaction.status}`);
      } else {
        await this.dbLogger.info(`No transactions found for user ${user_id}'s active subscription ${activeSubscription.payhere_sub_id}`);
      }
      
      return latestTransaction || null;
    } catch (error) {
      await this.dbLogger.error(`Error fetching latest transaction for user ${user_id}: ${error.message}`);
      return null;
    }
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
      await this.dbLogger.info(`Calculating DCA summary for user ${user_id}`);
      
      // Find all user's subscriptions
      const subscriptions: Subscription[] = await this.knexService
        .knex<Subscription>('subscription')
        .where('user_id', user_id);

      if (subscriptions.length === 0) {
        await this.dbLogger.info(`No subscriptions found for user ${user_id} - returning null DCA summary`);
        return null;
      }

      const subscriptionIds = subscriptions.map(sub => sub.payhere_sub_id);
      await this.dbLogger.info(`Found ${subscriptions.length} subscriptions for user ${user_id}: ${subscriptionIds.join(', ')}`);

      // Get all successful transactions with Bitcoin data across ALL user subscriptions
      const transactions = await this.knexService
        .knex<Transaction>('transaction')
        .whereIn('payhere_sub_id', subscriptionIds)
        .whereNotNull('satoshis_purchased')
        .where('status', 'SUCCESS');

      await this.dbLogger.info(`Found ${transactions.length} successful transactions with Bitcoin data for user ${user_id}`);

      if (transactions.length === 0) {
        await this.dbLogger.info(`No successful transactions with Bitcoin data for user ${user_id} - returning empty summary`);
        return {
          total_transactions: 0,
          successful_transactions: 0,
          total_satoshis_purchased: 0,
          total_amount_spent: 0,
          average_btc_price: 0,
          currency: 'LKR',
        };
      }

      // Use Big.js for precise satoshi calculations
      const totalSatoshis = transactions.reduce(
        (sum, tx) => {
          const satoshis = tx.satoshis_purchased ? new Big(tx.satoshis_purchased) : new Big(0);
          return sum.plus(satoshis);
        },
        new Big(0),
      );

      // Calculate total spent using Big.js for precision
      const totalSpent = transactions.reduce(
        (sum, tx) => {
          if (tx.btc_price_at_purchase && tx.satoshis_purchased) {
            // Convert satoshis to BTC (divide by 100,000,000) and multiply by price
            const satoshisBig = new Big(tx.satoshis_purchased);
            const btcAmount = satoshisBig.div(100_000_000);
            const spentAmount = btcAmount.times(tx.btc_price_at_purchase);
            return sum.plus(spentAmount);
          }
          return sum;
        },
        new Big(0),
      );

      // Calculate average BTC price using Big.js
      const averageBTCPrice = 
        totalSpent.gt(0) && totalSatoshis.gt(0)
          ? totalSpent.div(totalSatoshis.div(100_000_000))
          : new Big(0);

      const dates = transactions
        .map((tx) => tx.created_at)
        .filter((date) => date)
        .sort();

      // Convert Big.js values to numbers for the response
      const summary = {
        total_transactions: transactions.length,
        successful_transactions: transactions.length,
        total_satoshis_purchased: Number(totalSatoshis.toString()),
        total_amount_spent: Number(totalSpent.toString()),
        average_btc_price: Number(averageBTCPrice.toString()),
        currency: transactions[0]?.price_currency || 'LKR',
        first_purchase_date: dates.length > 0 ? dates[0] : undefined,
        last_purchase_date:
          dates.length > 0 ? dates[dates.length - 1] : undefined,
      };

      await this.dbLogger.info(`DCA summary calculated for user ${user_id}: ${totalSatoshis.toString()} total sats, ${totalSpent.toFixed(2)} ${summary.currency} spent, avg price ${averageBTCPrice.toFixed(2)}`);
      return summary;
    } catch (error) {
      await this.dbLogger.error(`Error calculating DCA summary for user ${user_id}: ${error.message}`);
      return null;
    }
  }

  private async ensureSubscriptionExists(
    payhere_sub_id: string,
    user_id?: string,
    package_id?: string,
  ): Promise<void> {
    try {
      // Check if subscription already exists
      const existingSubscription = await this.knexService
        .knex<Subscription>('subscription')
        .where('payhere_sub_id', payhere_sub_id)
        .first();

      if (existingSubscription) {
        await this.dbLogger.info(`Subscription ${payhere_sub_id} already exists`);
        return;
      }

      // Create new subscription if we have the required data
      if (user_id && package_id) {
        await this.dbLogger.info(`Creating new subscription: ${payhere_sub_id} for user ${user_id}, package ${package_id}`);
        
        await this.knexService.knex('subscription').insert({
          payhere_sub_id,
          user_id,
          package_id,
          is_active: true,
        });

        await this.dbLogger.info(`New subscription ${payhere_sub_id} created successfully`);
      } else {
        await this.dbLogger.warn(`Cannot create subscription ${payhere_sub_id}: missing user_id (${user_id}) or package_id (${package_id})`);
      }
    } catch (error) {
      await this.dbLogger.error(`Error ensuring subscription exists for ${payhere_sub_id}: ${error.message}`);
      // Don't throw error here as we still want to process the transaction
    }
  }
}
