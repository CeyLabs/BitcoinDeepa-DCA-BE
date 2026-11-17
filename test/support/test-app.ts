import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { SchedulerRegistry } from '@nestjs/schedule';
import { createHash, createHmac } from 'crypto';
import type { Knex } from 'knex';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { KnexService } from '../../src/modules/knex/knex.service';
import { RedisService } from '../../src/modules/redis/redis.service';
import { CoinMarketCapService } from '../../src/modules/coinmarketcap/coinmarketcap.service';
import { BitcoinPriceService } from '../../src/modules/bitcoin-price/bitcoin-price.service';
import { BitcoinDeepaService } from '../../src/modules/bitcoindeepa/bitcoindeepa.service';
import { PayHereService } from '../../src/modules/payhere/payhere.service';
import { DiditService } from '../../src/modules/didit/didit.service';

/** Fixed market data so satoshi amounts are deterministic. */
export const BTC_USD = 65_000;
export const USD_LKR = 300; // => 1 BTC = 19,500,000 LKR
export const sats = (netLkr: number) =>
  Math.floor((netLkr / (BTC_USD * USD_LKR)) * 100_000_000);

export const PACKAGE_WEEKLY = '00000000-0000-0000-0000-000000000001';
export const PACKAGE_MONTHLY = '00000000-0000-0000-0000-000000000004';
export const USER = '100000001';
export const OTHER_USER = '100000002';

export interface TestContext {
  app: INestApplication;
  knex: Knex;
  bitcoinDeepa: {
    isConfigured: jest.Mock;
    transferFunds: jest.Mock;
    getUserBalance: jest.Mock;
    getUserTransactions: jest.Mock;
  };
  didit: { createVerificationSession: jest.Mock; getSession: jest.Mock };
  payHereCancel: jest.SpyInstance;
  /** PayHere's payment lookup used by settlement (see below) */
  payHerePayments: jest.SpyInstance;
  tokenFor: (userId: string) => string;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const bitcoinDeepa = {
    isConfigured: jest.fn().mockReturnValue(true),
    transferFunds: jest.fn().mockResolvedValue({ success: true }),
    getUserBalance: jest
      .fn()
      .mockResolvedValue({ success: true, balance: 0, balance_lkr: '0.00' }),
    getUserTransactions: jest.fn().mockResolvedValue({
      success: true,
      transactions: [],
      count: 0,
    }),
  };
  const didit = {
    createVerificationSession: jest.fn(),
    getSession: jest.fn().mockResolvedValue(null),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CoinMarketCapService)
    .useValue({
      fetchBitcoinData: jest
        .fn()
        .mockResolvedValue({ price: BTC_USD, percent_change_24h: 1.5 }),
    })
    .overrideProvider(BitcoinDeepaService)
    .useValue(bitcoinDeepa)
    .overrideProvider(DiditService)
    .useValue(didit)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();

  // Crons are triggered explicitly by the tests, never on a timer.
  const scheduler = app.get(SchedulerRegistry);
  scheduler.getCronJobs().forEach((job) => void job.stop());

  // USD/LKR comes from an external FX API - pin it.
  // (private method - typed through app.get's result type parameter)
  const priceService = app.get<
    BitcoinPriceService,
    { getUsdLkrRate: () => Promise<number | null> }
  >(BitcoinPriceService);
  jest.spyOn(priceService, 'getUsdLkrRate').mockResolvedValue(USD_LKR);

  const payHereCancel = jest
    .spyOn(app.get(PayHereService), 'cancelSubscription')
    .mockResolvedValue({ status: 1, msg: 'Successfully cancelled' });

  const knex = app.get(KnexService).knex;
  await knex.migrate.latest();

  // PayHere "knows" every SUCCESS payment recorded for the subscription, like
  // the real API would. Tests override it to simulate a forged payment_id.
  const payHerePayments = jest
    .spyOn(app.get(PayHereService), 'getSubscriptionPayments')
    .mockImplementation(async (payhere_sub_id: string) => {
      const rows: { payhere_pay_id: string }[] = await knex('transaction')
        .select('payhere_pay_id')
        .where({ payhere_sub_id, status: 'SUCCESS' });
      return rows.map((r) => ({
        payment_id: r.payhere_pay_id,
        status: 'RECEIVED',
      }));
    });

  const jwt = app.get(JwtService);
  return {
    app,
    knex,
    bitcoinDeepa,
    didit,
    payHereCancel,
    payHerePayments,
    tokenFor: (userId) => jwt.sign({ id: userId, username: `u${userId}` }),
    close: () => app.close(),
  };
}

/** Wipe app tables and Redis, then insert the base fixtures. */
export async function resetData(ctx: TestContext): Promise<void> {
  const { knex, app } = ctx;
  await knex.raw(
    'TRUNCATE "transaction", subscription, payhere_order, "user", package RESTART IDENTITY CASCADE',
  );
  await knex('package').insert([
    {
      id: PACKAGE_WEEKLY,
      name: 'Shrimp Weekly',
      frequency: 'weekly',
      amount: 1000,
      currency: 'LKR',
    },
    {
      id: PACKAGE_MONTHLY,
      name: 'Shrimp Monthly',
      frequency: 'monthly',
      amount: 3000,
      currency: 'LKR',
    },
  ]);
  const profile = {
    email: 'test@example.com',
    phone: '0771234567',
    address: 'No.1, Galle Road',
    city: 'Colombo',
    country: 'Sri Lanka',
  };
  await knex('user').insert([
    {
      id: USER,
      first_name: 'Test',
      last_name: 'User',
      ...profile,
      kyc_status: 'APPROVED',
    },
    {
      id: OTHER_USER,
      first_name: 'Other',
      last_name: 'User',
      ...profile,
      kyc_status: 'NOT_STARTED',
    },
  ]);
  await app.get(RedisService).delByPattern('dca:*');
  jest.clearAllMocks();
}

const md5U = (s: string) =>
  createHash('md5').update(s).digest('hex').toUpperCase();

/** A PayHere notify_url payload signed with the test merchant secret. */
export function payhereNotification(fields: {
  order_id: string;
  payment_id: string;
  subscription_id: string;
  payhere_amount?: string;
  status_code?: string;
  [key: string]: string | undefined;
}): Record<string, string> {
  const n: Record<string, string> = {
    merchant_id: process.env.PAYHERE_MERCHANT_ID!,
    payhere_amount: '1000.00',
    payhere_currency: 'LKR',
    status_code: '2',
    ...Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ),
  } as Record<string, string>;
  n.md5sig ??= md5U(
    n.merchant_id +
      n.order_id +
      n.payhere_amount +
      n.payhere_currency +
      n.status_code +
      md5U(process.env.PAYHERE_MERCHANT_SECRET!),
  );
  return n;
}

/** Headers + raw body for a Didit webhook signed like Didit does. */
export function diditWebhook(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return {
    raw,
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Signature': createHmac('sha256', process.env.DIDIT_WEBHOOK_SECRET!)
        .update(raw)
        .digest('hex'),
    },
  };
}
