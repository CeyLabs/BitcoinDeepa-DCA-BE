import {
  BadRequestException,
  HttpException,
  HttpStatus,
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
import {
  buyLimits,
  paidOneTimeLkr,
  reservedOneTimeLkr,
} from '../../common/buy-limits';

const CURRENCY = 'LKR';

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
  /** Paid, but held for a manual check before the sats are sent */
  held: boolean;
  /** Until then the checkout can be paid */
  expires_at: Date;
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
      minLkr: buyLimits.minLkr(),
      maxLkr: buyLimits.maxLkr(),
      dailyMaxLkr: buyLimits.dailyMaxLkr(),
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
    const min = buyLimits.minLkr();
    const max = buyLimits.maxLkr();
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
      // Two checkouts at the same moment are limit-checked one after the
      // other (each sees the other's reservation)
      await trx('user').where('id', userId).forNoKeyUpdate().first();
      await this.assertLinkRate(trx, userId);
      await this.assertWithinDailyLimit(trx, userId, amountLkr);
      await trx('payhere_order').insert({
        order_id: orderId,
        user_id: userId,
        package_id: null,
        kind: 'ONE_TIME',
        amount: amountLkr,
        currency: CURRENCY,
        expires_at: trx.raw(`now() + make_interval(mins => ?)`, [
          buyLimits.orderTtlMinutes(),
        ]),
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
   * At most BUY_LINKS_PER_HOUR checkouts per user per hour. Counted from
   * payhere_order (every link stores one), so it holds across instances.
   */
  private async assertLinkRate(
    db: Knex.Transaction,
    userId: string,
  ): Promise<void> {
    const row = await db('payhere_order')
      .where('user_id', userId)
      .where('kind', 'ONE_TIME')
      .where('created_at', '>', db.raw("now() - interval '1 hour'"))
      .count<{ count: string }[]>('* as count')
      .first();
    if (Number(row?.count ?? 0) >= buyLimits.linksPerHour()) {
      throw new HttpException(
        'Too many checkouts started. Please try again in a while.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Refuse a checkout that would take the member past the rolling 24h limit:
   * payments already made plus checkouts that can still be paid (reserved
   * until they expire). The webhook checks again when a payment arrives.
   */
  private async assertWithinDailyLimit(
    db: Knex.Transaction,
    userId: string,
    amountLkr: number,
  ): Promise<void> {
    const used =
      (await paidOneTimeLkr(db, userId)) +
      (await reservedOneTimeLkr(db, userId));
    const max = buyLimits.dailyMaxLkr();
    if (used + amountLkr > max) {
      const left = Math.max(0, max - used);
      throw new BadRequestException(
        left > 0
          ? `You can buy up to ${left.toLocaleString('en-US')} LKR more today (unfinished checkouts count until they expire)`
          : `You've reached today's limit of ${max.toLocaleString('en-US')} LKR (unfinished checkouts count until they expire)`,
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
      expires_at: Date;
    }>('payhere_order')
      .select('order_id', 'amount', 'currency', 'created_at', 'expires_at')
      .where({ order_id: orderId, user_id: userId, kind: 'ONE_TIME' })
      .first();
    if (!order) throw new NotFoundException('Order not found');

    // Normally one payment; if the order was paid twice, show the latest
    const tx = await this.knex<{
      payhere_pay_id: string;
      status: Status;
      satoshis_purchased: string | null;
      settled: boolean;
      hold_reason: string | null;
      created_at: Date;
    }>('transaction')
      .select(
        'payhere_pay_id',
        'status',
        'satoshis_purchased',
        'settled',
        'hold_reason',
      )
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
      // The reason is for the team, not the member
      held: !!tx?.hold_reason && !tx.settled,
      expires_at: order.expires_at,
    };
  }
}
