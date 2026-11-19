import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { KnexService } from '../knex/knex.service';
import { UserService } from '../user/user.service';
import { PayHereService } from '../payhere/payhere.service';
import { BitcoinPriceService } from '../bitcoin-price/bitcoin-price.service';
import type { Status } from '../transaction/transaction.service';
import { computeBuyFees } from '../../common/buy-fees';

const CURRENCY = 'LKR';
export const DEFAULT_BUY_MIN_LKR = 100;
export const DEFAULT_BUY_MAX_LKR = 100_000;
export const DEFAULT_BUY_DAILY_MAX_LKR = 250_000;
// One-time payments that count towards the daily limit. CANCELLED/FAILED
// moved no money.
const COUNTED_BUY_STATUSES: Status[] = ['PENDING', 'SUCCESS', 'CHARGEBACK'];

export type BuyOrderStatus = 'AWAITING_PAYMENT' | Status;

export interface BuyOrderView {
  order_id: string;
  amount_lkr: number;
  currency: string;
  created_at: Date;
  /** AWAITING_PAYMENT until PayHere notifies us */
  status: BuyOrderStatus;
  payhere_pay_id: string | null;
  satoshis: number | null;
  settled: boolean;
}

@Injectable()
export class BuyService {
  private readonly logger = new Logger(BuyService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly userService: UserService,
    private readonly payHereService: PayHereService,
    private readonly bitcoinPriceService: BitcoinPriceService,
  ) {}

  private get knex(): Knex {
    return this.knexService.knex;
  }

  static minLkr(): number {
    return parseInt(process.env.BUY_MIN_LKR || String(DEFAULT_BUY_MIN_LKR), 10);
  }

  static maxLkr(): number {
    return parseInt(process.env.BUY_MAX_LKR || String(DEFAULT_BUY_MAX_LKR), 10);
  }

  static dailyMaxLkr(): number {
    return parseInt(
      process.env.BUY_DAILY_MAX_LKR || String(DEFAULT_BUY_DAILY_MAX_LKR),
      10,
    );
  }

  /** Live BTC/LKR, fees and limits for the buy screen. An estimate only. */
  async getPrice(): Promise<{
    btcLkrPrice: number;
    paymentProcessorFeeBasisPoints: number;
    bitcoindeepaFeeBasisPoints: number;
    minLkr: number;
    maxLkr: number;
    dailyMaxLkr: number;
  }> {
    const price = await this.bitcoinPriceService.getCurrentPrice();
    if (!price) {
      throw new ServiceUnavailableException(
        'Bitcoin price is unavailable right now, please try again shortly',
      );
    }
    // Fees don't depend on the amount; computed on 0 just to read the bps
    const fees = computeBuyFees(0);
    return {
      btcLkrPrice: price.lkr,
      paymentProcessorFeeBasisPoints: fees.paymentProcessorFeeBps,
      bitcoindeepaFeeBasisPoints: fees.bitcoindeepaFeeBps,
      minLkr: BuyService.minLkr(),
      maxLkr: BuyService.maxLkr(),
      dailyMaxLkr: BuyService.dailyMaxLkr(),
    };
  }

  /**
   * Store a ONE_TIME payhere_order and return its PayHere checkout link.
   * The webhook only accepts a one-off payment for an order stored here, for
   * exactly this amount.
   */
  async createPayHereLink(
    userId: string,
    amountLkr: number,
  ): Promise<{ link: string; order_id: string }> {
    const min = BuyService.minLkr();
    const max = BuyService.maxLkr();
    if (amountLkr < min || amountLkr > max) {
      throw new BadRequestException(
        `Amount must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')} LKR`,
      );
    }

    const user = await this.userService.getUserOrThrow(userId);
    if (!this.userService.isProfileComplete(user)) {
      throw new BadRequestException(
        'Please complete your profile before buying',
      );
    }

    const orderId = randomUUID();
    await this.knex.transaction(async (trx) => {
      // Two checkouts at the same moment are limit-checked one after the other
      await trx('user').where('id', userId).forNoKeyUpdate().first();
      await this.assertWithinDailyLimit(trx, userId, amountLkr);
      await trx('payhere_order').insert({
        order_id: orderId,
        user_id: userId,
        package_id: null,
        kind: 'ONE_TIME',
        amount: amountLkr,
        currency: CURRENCY,
      });
    });

    const link = this.payHereService.getLink({
      user_id: userId,
      order_id: orderId,
      amount: String(amountLkr),
      currency: CURRENCY,
      first_name: user.first_name,
      last_name: user.last_name ?? '',
      email: user.email,
      phone: user.phone,
      address: user.address,
      city: user.city,
      country: user.country,
      items: 'Bitcoin purchase',
      type: 'checkout',
      // The app's success/cancel pages show this order's progress
      return_query: { buy_order: orderId },
    });
    this.logger.log(
      `One-time buy link generated for user ${userId}: ${amountLkr} ${CURRENCY}, order ${orderId}`,
    );
    return { link, order_id: orderId };
  }

  /**
   * Refuse a checkout that would take the member past the rolling 24h limit.
   * Counts payments PayHere told us about; unpaid links don't count (they
   * may never be paid), so several links opened at once can each pass.
   */
  private async assertWithinDailyLimit(
    db: Knex | Knex.Transaction,
    userId: string,
    amountLkr: number,
  ): Promise<void> {
    const row = await db('transaction')
      .where('user_id', userId)
      .where('kind', 'ONE_TIME')
      .whereIn('status', COUNTED_BUY_STATUSES)
      .where('created_at', '>', db.raw("now() - interval '24 hours'"))
      .sum<{ total: string | null }>('gross_amount as total')
      .first();
    const used = Number(row?.total ?? 0);
    const max = BuyService.dailyMaxLkr();
    if (used + amountLkr > max) {
      const left = Math.max(0, max - used);
      throw new BadRequestException(
        left > 0
          ? `You can buy up to ${left.toLocaleString('en-US')} LKR more today`
          : `You've reached today's limit of ${max.toLocaleString('en-US')} LKR`,
      );
    }
  }

  /** A one-time order of this user, with its payment's progress. */
  async getOrder(userId: string, orderId: string): Promise<BuyOrderView> {
    const order = await this.knex<{
      order_id: string;
      user_id: string;
      kind: string;
      amount: string;
      currency: string;
      created_at: Date;
    }>('payhere_order')
      .select('order_id', 'amount', 'currency', 'created_at')
      .where({ order_id: orderId, user_id: userId, kind: 'ONE_TIME' })
      .first();
    if (!order) throw new NotFoundException('Order not found');

    // Normally one payment; if the order was paid twice, show the latest
    const tx = await this.knex<{
      payhere_pay_id: string;
      status: Status;
      satoshis_purchased: string | null;
      settled: boolean;
      created_at: Date;
    }>('transaction')
      .select('payhere_pay_id', 'status', 'satoshis_purchased', 'settled')
      .where('payhere_order_id', orderId)
      .orderBy('created_at', 'desc')
      .first();

    return {
      order_id: order.order_id,
      amount_lkr: Number(order.amount),
      currency: order.currency,
      created_at: order.created_at,
      status: tx?.status ?? 'AWAITING_PAYMENT',
      payhere_pay_id: tx?.payhere_pay_id ?? null,
      satoshis:
        tx?.satoshis_purchased == null ? null : Number(tx.satoshis_purchased),
      settled: tx?.settled ?? false,
    };
  }
}
