import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { KnexService } from '../knex/knex.service';
import { Subscription } from '../../models/subscription';
import { BitcoinPriceService } from '../bitcoin-price/bitcoin-price.service';
import { DatabaseLoggerService } from '../knex/database-logger.service';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import {
  BitcoinDeepaService,
  UserBalanceResponse,
} from '../bitcoindeepa/bitcoindeepa.service';
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
  settled?: boolean;
  retry_count?: number;
  last_retry_at?: Date;
  gross_amount?: number;
  fee_basis_points?: number;
  fee_amount?: number;
  net_amount?: number;
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
    private readonly redisService: RedisService,
    private readonly telegramLoggerService: TelegramLoggerService,
    private readonly bitcoinDeepaService: BitcoinDeepaService,
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
      await this.dbLogger.error(
        `MD5 signature verification failed for payment_id ${payment_id}, order_id ${order_id}: expected ${local_md5sig}, received ${md5sig}`,
      );
      throw new UnauthorizedException('Md5 verification failed');
    }

    await this.dbLogger.info(
      `MD5 signature verified for payment_id ${payment_id}, order_id ${order_id}`,
    );

    const status = this.getPayHereStatusMapped(status_code);
    await this.dbLogger.info(
      `Processing PayHere notification: payment_id=${payment_id}, subscription_id=${subscription_id}, status=${status}, amount=${payhere_amount} ${payhere_currency}`,
    );

    if (!subscription_id || Number(subscription_id) < 0) {
      await this.dbLogger.error(
        `Invalid subscription id: ${subscription_id} for payment_id ${payment_id}`,
      );
      throw new InternalServerErrorException('Invalid subscription id');
    }

    // Pre-fetch Bitcoin data outside transaction to avoid long-running transactions
    let bitcoinDataForUpdate: any = null;
    let bitcoinDataForNew: any = null;

    // Check if we need Bitcoin data for existing transaction update
    const existingTransaction = await this.knexService
      .knex<Transaction>('transaction')
      .where('payhere_pay_id', payment_id)
      .first();

    if (
      existingTransaction &&
      status === 'SUCCESS' &&
      !existingTransaction.satoshis_purchased
    ) {
      await this.dbLogger.info(
        `Pre-fetching Bitcoin data for existing transaction ${payment_id}`,
      );
      bitcoinDataForUpdate = await this.fetchBitcoinDataForTransaction(
        parseFloat(payhere_amount),
        payhere_currency,
      );
    }

    // Pre-fetch Bitcoin data for new successful transactions
    if (!existingTransaction && status === 'SUCCESS') {
      await this.dbLogger.info(
        `Pre-fetching Bitcoin data for new transaction ${payment_id}`,
      );
      bitcoinDataForNew = await this.fetchBitcoinDataForTransaction(
        parseFloat(payhere_amount),
        payhere_currency,
      );
    }

    // Use atomic transaction for all database operations only
    const trx = await this.knexService.knex.transaction();

    try {
      await this.dbLogger.info(
        `Starting atomic processing for payment_id ${payment_id}`,
      );

      // Re-check if transaction exists within transaction (for consistency)
      const currentTransaction = await trx('transaction')
        .where('payhere_pay_id', payment_id)
        .first();

      if (currentTransaction) {
        await this.dbLogger.info(
          `Updating existing transaction ${payment_id}: ${currentTransaction.status} → ${status}`,
        );

        const updateData: Partial<Transaction> = { status };

        // Add pre-fetched Bitcoin data if available
        if (bitcoinDataForUpdate) {
          Object.assign(updateData, bitcoinDataForUpdate);
          await this.dbLogger.info(
            `Bitcoin data added to transaction ${payment_id}: ${bitcoinDataForUpdate.satoshis_purchased} sats at ${bitcoinDataForUpdate.btc_price_at_purchase} ${bitcoinDataForUpdate.price_currency}`,
          );
        }

        await trx('transaction')
          .update(updateData)
          .where('payhere_pay_id', payment_id);

        await this.dbLogger.info(
          `Transaction ${payment_id} updated successfully`,
        );
      } else {
        // Ensure subscription exists before creating transaction
        await this.ensureSubscriptionExistsAtomic(
          trx,
          subscription_id,
          user_id,
          package_id,
        );

        // Create new transaction with pre-fetched Bitcoin data
        await this.dbLogger.info(
          `Creating new transaction for payment_id ${payment_id}, subscription_id ${subscription_id}, status ${status}`,
        );

        const transactionData: Transaction = {
          payhere_pay_id: payment_id,
          payhere_sub_id: subscription_id,
          status,
          retry_count: 0,
        };

        // Add pre-fetched Bitcoin data if available
        if (bitcoinDataForNew) {
          Object.assign(transactionData, bitcoinDataForNew);
          await this.dbLogger.info(
            `Bitcoin data added to new transaction ${payment_id}: ${bitcoinDataForNew.satoshis_purchased} sats at ${bitcoinDataForNew.btc_price_at_purchase} ${bitcoinDataForNew.price_currency}`,
          );
        }

        await this.createTransactionAtomic(trx, transactionData);
        await this.dbLogger.info(
          `New transaction ${payment_id} created successfully`,
        );
      }

      // All successful transactions with Bitcoin data will be picked up by Settlement Service
      // No fund transfer is attempted here to keep webhook processing fast and reliable

      // Commit all database operations
      await trx.commit();
      await this.dbLogger.info(
        `Atomic processing completed successfully for payment_id ${payment_id}`,
      );

      // Invalidate user caches after successful commit (non-critical operation)
      if (user_id) {
        try {
          await this.invalidateUserTransactionCaches(user_id);
        } catch (cacheError: unknown) {
          // Log cache error but don't fail the operation since DB operation succeeded
          await this.dbLogger.warn(
            `Failed to invalidate cache after successful transaction processing ${payment_id}: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`,
          );
        }
      }
    } catch (error: unknown) {
      // Rollback all changes on any error
      await trx.rollback();
      await this.dbLogger.error(
        `Atomic processing failed for payment_id ${payment_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async createTransaction(transaction: Transaction): Promise<Transaction> {
    try {
      const result = await this.knexService
        .knex('transaction')
        .insert(transaction)
        .returning('*');

      await this.dbLogger.info(
        `Transaction inserted into database: ${transaction.payhere_pay_id}`,
      );
      return result[0] as Transaction;
    } catch (error: unknown) {
      await this.dbLogger.error(
        `Failed to insert transaction ${transaction.payhere_pay_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  getPayHereStatusMapped(status_code: string): Status {
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
    gross_amount: number;
    fee_basis_points: number;
    fee_amount: number;
    net_amount: number;
  } | null> {
    try {
      // Check if Bitcoin tracking is enabled
      if (process.env.ENABLE_BITCOIN_TRACKING === 'false') {
        await this.dbLogger.info(
          'Bitcoin tracking is disabled - skipping Bitcoin data fetch',
        );
        return null;
      }

      // Get fee configuration from environment (default to 100 basis points = 1%)
      const feeBasisPoints = parseInt(
        process.env.FEE_BASIS_POINTS || '100',
        10,
      );

      // Store gross amount (original package amount)
      const grossAmount = amount;

      // Calculate fee amount (basis points / 10000)
      // Example: 100 basis points = 1% = 100/10000 = 0.01
      const feeAmount = new Big(grossAmount)
        .times(feeBasisPoints)
        .div(10000)
        .toNumber();

      // Calculate net amount after fee
      const netAmount = new Big(grossAmount).minus(feeAmount).toNumber();

      await this.dbLogger.info(
        `Calculating Bitcoin for ${grossAmount} ${currency}: fee=${feeAmount} ${currency} (${feeBasisPoints} bps), net=${netAmount} ${currency}`,
      );

      // Use net amount for satoshi calculation
      const bitcoinCalculation =
        await this.bitcoinPriceService.calculateSatoshis(netAmount, currency);

      if (!bitcoinCalculation) {
        await this.dbLogger.warn(
          `Failed to fetch Bitcoin price for ${netAmount} ${currency} - CoinGecko API may be unavailable`,
        );
        return null;
      }

      await this.dbLogger.info(
        `Bitcoin DCA calculation: ${netAmount} ${currency} (after ${feeAmount} ${currency} fee) = ${bitcoinCalculation.satoshis} satoshis at ${bitcoinCalculation.btc_price} ${currency}/BTC`,
      );

      return {
        btc_price_at_purchase: bitcoinCalculation.btc_price,
        satoshis_purchased: bitcoinCalculation.satoshis,
        price_currency: bitcoinCalculation.currency,
        coingecko_timestamp: bitcoinCalculation.timestamp,
        gross_amount: grossAmount,
        fee_basis_points: feeBasisPoints,
        fee_amount: feeAmount,
        net_amount: netAmount,
      };
    } catch (error: unknown) {
      await this.dbLogger.error(
        `Error fetching Bitcoin data for transaction (${amount} ${currency}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async getTransactionsByUserId(user_id: string): Promise<Transaction[]> {
    // Find all user's subscriptions
    const subscriptions: Subscription[] = await this.knexService
      .knex<Subscription>('subscription')
      .where('user_id', user_id);

    if (subscriptions.length === 0) {
      await this.dbLogger.info(
        `No subscriptions found for user ${user_id} - returning empty transaction list`,
      );
      return [];
    }

    const subscriptionIds = subscriptions.map((sub) => sub.payhere_sub_id);

    // Fetch transactions for ALL subscriptions
    const transactions = await this.knexService
      .knex<Transaction>('transaction')
      .whereIn('payhere_sub_id', subscriptionIds)
      .orderBy('created_at', 'desc');

    await this.dbLogger.info(
      `Retrieved ${transactions.length} transactions for user ${user_id} across ${subscriptions.length} subscriptions`,
    );
    return transactions;
  }

  async getTransactionsByUserIdPaginated(
    user_id: string,
    page: number = 1,
    limit: number = 10,
  ): Promise<{
    transactions: Transaction[];
    total_count: number;
    total_pages: number;
    current_page: number;
    has_more: boolean;
  }> {
    try {
      const cacheKey = CacheKeys.transaction.list(user_id, page, limit);

      // Try to get from cache first
      const cached = await this.redisService.get<{
        transactions: Transaction[];
        total_count: number;
        total_pages: number;
        current_page: number;
        has_more: boolean;
      }>(cacheKey);

      if (cached) {
        return cached;
      }

      await this.dbLogger.info(
        `Cache MISS for user transactions: ${user_id} (page: ${page}, limit: ${limit}), fetching from database`,
      );

      // Find all user's subscriptions
      const subscriptions: Subscription[] = await this.knexService
        .knex<Subscription>('subscription')
        .where('user_id', user_id);

      if (subscriptions.length === 0) {
        await this.dbLogger.info(
          `No subscriptions found for user ${user_id} - returning empty paginated result`,
        );
        const emptyResult = {
          transactions: [],
          total_count: 0,
          total_pages: 0,
          current_page: page,
          has_more: false,
        };

        // Cache empty result for 2 minutes
        await this.redisService.set(cacheKey, emptyResult, { ttl: 120 });
        return emptyResult;
      }

      const subscriptionIds = subscriptions.map((sub) => sub.payhere_sub_id);

      // Get total count for pagination
      const [countResult] = await this.knexService
        .knex<Transaction>('transaction')
        .whereIn('payhere_sub_id', subscriptionIds)
        .count('* as count');

      const totalCount = Number((countResult as any).count);
      const totalPages = Math.ceil(totalCount / limit);
      const offset = (page - 1) * limit;

      // Fetch paginated transactions
      const transactions = await this.knexService
        .knex<Transaction>('transaction')
        .whereIn('payhere_sub_id', subscriptionIds)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset);

      const hasMore = page < totalPages;

      const result = {
        transactions,
        total_count: totalCount,
        total_pages: totalPages,
        current_page: page,
        has_more: hasMore,
      };

      // Cache the result for 2 minutes (120 seconds)
      await this.redisService.set(cacheKey, result, { ttl: 120 });

      await this.dbLogger.info(
        `Retrieved ${transactions.length} transactions for user ${user_id} (page ${page}/${totalPages}, total: ${totalCount})`,
      );

      return result;
    } catch (error: unknown) {
      await this.dbLogger.error(
        `Error fetching paginated transactions for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async getLatestTransactionForUser(user_id: string): Promise<any | null> {
    try {
      const cacheKey = CacheKeys.transaction.latest(user_id);

      // Try to get from cache first
      const cached = await this.redisService.get<any>(cacheKey);
      if (cached) {
        return cached;
      }

      await this.dbLogger.info(
        `Cache MISS for latest transaction: ${user_id}, fetching from database`,
      );

      // Find user's active subscription
      const activeSubscription: Subscription | undefined =
        await this.knexService
          .knex<Subscription>('subscription')
          .where('user_id', user_id)
          .where('is_active', true)
          .orderBy('created_at', 'desc')
          .first();

      if (!activeSubscription) {
        await this.dbLogger.info(
          `No active subscription found for user ${user_id} - returning null`,
        );
        return null;
      }

      // Get the latest transaction with package information
      const result = await this.knexService
        .knex('transaction as t')
        .select(
          't.payhere_pay_id',
          't.payhere_sub_id',
          't.status',
          't.btc_price_at_purchase',
          't.satoshis_purchased',
          't.price_currency',
          't.coingecko_timestamp',
          't.created_at',
          't.updated_at',
          'p.amount as package_amount',
          'p.currency as package_currency',
          'p.name as package_name',
          'p.frequency as package_frequency',
        )
        .join('subscription as s', 't.payhere_sub_id', 's.payhere_sub_id')
        .join('package as p', 's.package_id', 'p.id')
        .where('t.payhere_sub_id', activeSubscription.payhere_sub_id)
        .orderBy('t.created_at', 'desc')
        .first();

      if (result) {
        // Cache the result for 1 minute (60 seconds)
        await this.redisService.set(cacheKey, result, { ttl: 60 });
        await this.dbLogger.info(
          `Latest transaction found for user ${user_id}: ${result.payhere_pay_id} with status ${result.status}, package: ${result.package_name} (${result.package_amount} ${result.package_currency})`,
        );
      } else {
        await this.dbLogger.info(
          `No transactions found for user ${user_id}'s active subscription ${activeSubscription.payhere_sub_id}`,
        );
      }

      return result || null;
    } catch (error: unknown) {
      await this.dbLogger.error(
        `Error fetching latest transaction for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async getDCASummaryForUser(user_id: string): Promise<{
    dca: {
      balance: number;
      spent: number;
      avg_btc_price: number;
    };
    total_balance: number;
    total_lkr: string | undefined;
    currency: string;
    '24_hr_change': number;
  } | null> {
    try {
      const cacheKey = CacheKeys.transaction.dcaSummary(user_id);

      // Try to get from cache first
      const cached = await this.redisService.get<{
        dca: {
          balance: number;
          spent: number;
          avg_btc_price: number;
        };
        total_balance: number;
        total_lkr: string | undefined;
        currency: string;
        '24_hr_change': number;
      }>(cacheKey);

      if (cached) {
        return cached;
      }

      await this.dbLogger.info(
        `Cache MISS for DCA summary: ${user_id}, calculating from database`,
      );

      // Find all user's subscriptions
      const subscriptions: Subscription[] = await this.knexService
        .knex<Subscription>('subscription')
        .where('user_id', user_id);

      if (subscriptions.length === 0) {
        await this.dbLogger.info(
          `No subscriptions found for user ${user_id} - returning empty DCA summary`,
        );

        // Fetch total balance from BitcoinDeepa API even without subscriptions
        let totalBalanceFromAPI = 0;
        let balanceResponse = {} as UserBalanceResponse;
        try {
          if (this.bitcoinDeepaService.isConfigured()) {
            balanceResponse = await this.bitcoinDeepaService.getUserBalance(
              parseInt(user_id, 10),
            );
            if (balanceResponse.success && balanceResponse.balance) {
              totalBalanceFromAPI = balanceResponse.balance;
            }
          }
        } catch (error: unknown) {
          await this.dbLogger.warn(
            `Failed to fetch balance from BitcoinDeepa API for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Fetch 24hr change from CoinGecko even without subscriptions
        let bitcoin24HrChange = 0;
        try {
          const change = await this.bitcoinPriceService.getBitcoin24HrChange();
          if (typeof change === 'number') {
            bitcoin24HrChange = change;
          }
        } catch (error: unknown) {
          await this.dbLogger.warn(
            `Failed to fetch 24hr change from CoinGecko for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const emptyResult = {
          dca: {
            balance: 0,
            spent: 0,
            avg_btc_price: 0,
          },
          total_balance: totalBalanceFromAPI,
          total_lkr: balanceResponse.balance_lkr || '0.00',
          currency: 'LKR',
          '24_hr_change': bitcoin24HrChange,
        };

        // Cache empty result for 5 minutes
        await this.redisService.set(cacheKey, emptyResult, { ttl: 300 });
        return emptyResult;
      }

      const subscriptionIds = subscriptions.map((sub) => sub.payhere_sub_id);
      await this.dbLogger.info(
        `Found ${subscriptions.length} subscriptions for user ${user_id}: ${subscriptionIds.join(', ')}`,
      );

      // Get all successful transactions with Bitcoin data across ALL user subscriptions
      const transactions = await this.knexService
        .knex<Transaction>('transaction')
        .whereIn('payhere_sub_id', subscriptionIds)
        .whereNotNull('satoshis_purchased')
        .where('status', 'SUCCESS');

      await this.dbLogger.info(
        `Found ${transactions.length} successful transactions with Bitcoin data for user ${user_id}`,
      );

      if (transactions.length === 0) {
        await this.dbLogger.info(
          `No successful transactions with Bitcoin data for user ${user_id} - returning empty summary`,
        );
        const emptyResult = {
          dca: {
            balance: 0,
            spent: 0,
            avg_btc_price: 0,
          },
          total_balance: 0,
          total_lkr: '0.00',
          currency: 'LKR',
          '24_hr_change': 0,
        };

        // Cache empty result for 5 minutes
        await this.redisService.set(cacheKey, emptyResult, { ttl: 300 });
        return emptyResult;
      }

      // Use Big.js for precise satoshi calculations
      const totalSatoshis = transactions.reduce((sum, tx) => {
        const satoshis = tx.satoshis_purchased
          ? new Big(tx.satoshis_purchased)
          : new Big(0);
        return sum.plus(satoshis);
      }, new Big(0));

      // Calculate total spent using Big.js for precision
      const totalSpent = transactions.reduce((sum, tx) => {
        if (tx.btc_price_at_purchase && tx.satoshis_purchased) {
          // Convert satoshis to BTC (divide by 100,000,000) and multiply by price
          const satoshisBig = new Big(tx.satoshis_purchased);
          const btcAmount = satoshisBig.div(100_000_000);
          const spentAmount = btcAmount.times(tx.btc_price_at_purchase);
          return sum.plus(spentAmount);
        }
        return sum;
      }, new Big(0));

      // Calculate average BTC price using Big.js
      const averageBTCPrice =
        totalSpent.gt(0) && totalSatoshis.gt(0)
          ? totalSpent.div(totalSatoshis.div(100_000_000))
          : new Big(0);

      // Fetch total balance from BitcoinDeepa API
      let totalBalanceFromAPI = 0;
      let balanceResponse = {} as UserBalanceResponse;
      try {
        if (this.bitcoinDeepaService.isConfigured()) {
          balanceResponse = await this.bitcoinDeepaService.getUserBalance(
            parseInt(user_id, 10),
          );
          if (balanceResponse.success && balanceResponse.balance) {
            totalBalanceFromAPI = balanceResponse.balance;
          }
        }
      } catch (error: unknown) {
        await this.dbLogger.warn(
          `Failed to fetch balance from BitcoinDeepa API for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Fetch 24hr change from CoinGecko
      let bitcoin24HrChange = 0;
      try {
        const change = await this.bitcoinPriceService.getBitcoin24HrChange();
        if (typeof change === 'number') {
          bitcoin24HrChange = change;
        }
      } catch (error: unknown) {
        await this.dbLogger.warn(
          `Failed to fetch 24hr change from CoinGecko for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Convert Big.js values to numbers for the response
      const summary = {
        dca: {
          balance: Number(totalSatoshis.toString()),
          spent: Number(totalSpent.toString()),
          avg_btc_price: Number(averageBTCPrice.toString()),
        },
        total_balance: totalBalanceFromAPI,
        total_lkr: balanceResponse.balance_lkr,
        currency: 'LKR',
        '24_hr_change': bitcoin24HrChange,
      };

      // Cache the result for 5 minutes (300 seconds)
      await this.redisService.set(cacheKey, summary, { ttl: 300 });

      await this.dbLogger.info(
        `DCA summary calculated for user ${user_id}: ${totalSatoshis.toString()} total sats, ${totalSpent.toFixed(2)} ${summary.currency} spent, avg price ${averageBTCPrice.toFixed(2)}`,
      );
      return summary;
    } catch (error: unknown) {
      await this.dbLogger.error(
        `Error calculating DCA summary for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Atomic version of ensureSubscriptionExists for use within transactions
   */
  private async ensureSubscriptionExistsAtomic(
    trx: any,
    payhere_sub_id: string,
    user_id?: string,
    package_id?: string,
  ): Promise<void> {
    // Check if subscription already exists within the transaction
    const existingSubscription = await trx('subscription')
      .where('payhere_sub_id', payhere_sub_id)
      .first();

    if (existingSubscription) {
      await this.dbLogger.info(
        `Subscription ${payhere_sub_id} already exists (atomic)`,
      );
      return;
    }

    // Create new subscription if we have the required data
    if (user_id && package_id) {
      await this.dbLogger.info(
        `Creating new subscription atomically: ${payhere_sub_id} for user ${user_id}, package ${package_id}`,
      );

      await trx('subscription').insert({
        payhere_sub_id,
        user_id,
        package_id,
        is_active: true,
      });

      await this.dbLogger.info(
        `New subscription ${payhere_sub_id} created successfully (atomic)`,
      );

      // Fetch package details for Telegram logging
      try {
        const _package = await trx('package').where('id', package_id).first();

        if (_package) {
          // Create user object for telegram logging
          await this.telegramLoggerService.logSubscriptionCreated(
            payhere_sub_id,
            user_id,
            _package,
          );
        } else {
          await this.dbLogger.warn(
            `Package ${package_id} not found for Telegram logging`,
          );
        }
      } catch (telegramError: unknown) {
        // Don't fail subscription creation if Telegram logging fails
        await this.dbLogger.error(
          `Failed to log subscription creation to Telegram: ${telegramError instanceof Error ? telegramError.message : String(telegramError)}`,
        );
      }
    } else {
      await this.dbLogger.warn(
        `Cannot create subscription ${payhere_sub_id}: missing user_id (${user_id}) or package_id (${package_id}) (atomic)`,
      );
      throw new InternalServerErrorException(
        'Insufficient data to create subscription',
      );
    }
  }

  /**
   * Atomic version of createTransaction for use within transactions
   */
  async createTransactionAtomic(
    trx: any,
    transaction: Transaction,
  ): Promise<Transaction> {
    const result = await trx('transaction').insert(transaction).returning('*');

    await this.dbLogger.info(
      `Transaction inserted atomically: ${transaction.payhere_pay_id}`,
    );
    return result[0] as Transaction;
  }

  /**
   * Invalidate all transaction-related caches for a user
   */
  async invalidateUserTransactionCaches(user_id: string): Promise<void> {
    try {
      // Invalidate latest transaction cache
      await this.redisService.del(CacheKeys.transaction.latest(user_id));

      // Invalidate DCA summary cache
      await this.redisService.del(CacheKeys.transaction.dcaSummary(user_id));

      // Invalidate paginated transaction lists (all pages)
      await this.redisService.delByPattern(
        CacheKeys.patterns.userTransactions(user_id),
      );

      await this.dbLogger.info(
        `Invalidated all transaction caches for user: ${user_id}`,
      );
    } catch (error: unknown) {
      await this.dbLogger.error(
        `Error invalidating transaction caches for user ${user_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
