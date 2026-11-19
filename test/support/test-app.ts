import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { SchedulerRegistry } from '@nestjs/schedule';
import { createHash, createHmac, randomUUID, sign } from 'crypto';
import type { Knex } from 'knex';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { KnexService } from '../../src/modules/knex/knex.service';
import { RedisService } from '../../src/modules/redis/redis.service';
import { BitcoinPriceService } from '../../src/modules/bitcoin-price/bitcoin-price.service';
import { BitcoinDeepaService } from '../../src/modules/bitcoindeepa/bitcoindeepa.service';
import { PayHereService } from '../../src/modules/payhere/payhere.service';
import { DiditService } from '../../src/modules/didit/didit.service';
import { CeyPayService } from '../../src/modules/ceypay/ceypay.service';
import { R2StorageService } from '../../src/modules/storage/r2-storage.service';
import { CoinMarketCapService } from '../../src/modules/coinmarketcap/coinmarketcap.service';
import { TelegramLoggerService } from '../../src/modules/telegram-logger/telegram-logger.service';

/**
 * Fixed market data so satoshi amounts are deterministic: Ceylon Cash BTC/USD
 * and CeyPay's USDT/LKR => 1 BTC = 21,450,000 LKR (buy, DCA and sell).
 */
export const BTC_USD = 65_000;
export const CEYPAY_USDT_LKR = 330;
export const BTC_LKR = BTC_USD * CEYPAY_USDT_LKR;
export const sats = (netLkr: number) =>
  Math.floor((netLkr / BTC_LKR) * 100_000_000);
export const BANKS = [
  { code: 7010, name: 'Bank of Ceylon' },
  { code: 7056, name: 'Commercial Bank PLC' },
];

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
    collectFunds: jest.Mock;
    getUserBalance: jest.Mock;
    getUserTransactions: jest.Mock;
  };
  didit: { createVerificationSession: jest.Mock; getSession: jest.Mock };
  ceyPay: {
    isConfigured: jest.Mock;
    getBanks: jest.Mock;
    upsertUser: jest.Mock;
    addBankAccount: jest.Mock;
    getQuote: jest.Mock;
    createOfframp: jest.Mock;
    getOfframp: jest.Mock;
    verifyWebhookSignature: jest.Mock;
  };
  storage: {
    isConfigured: jest.Mock;
    presignUpload: jest.Mock;
    presignDownload: jest.Mock;
    head: jest.Mock;
  };
  /** Telegram DMs to users (never sent for real) */
  notifyUser: jest.SpyInstance;
  payHereCancel: jest.SpyInstance;
  /** PayHere's payment lookup used by settlement (see below) */
  payHerePayments: jest.SpyInstance;
  payHereOrderPayments: jest.SpyInstance;
  tokenFor: (userId: string) => string;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const bitcoinDeepa = {
    isConfigured: jest.fn().mockReturnValue(true),
    transferFunds: jest.fn().mockResolvedValue({ success: true }),
    collectFunds: jest.fn().mockResolvedValue({ success: true }),
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

  // CeyPay's API is mocked, but webhook signatures are checked for real
  const realCeyPay = new CeyPayService();
  const ceyPay = {
    isConfigured: jest.fn().mockReturnValue(true),
    getBanks: jest.fn().mockResolvedValue(BANKS),
    upsertUser: jest.fn(),
    addBankAccount: jest.fn(),
    getQuote: jest.fn(quoteAt(CEYPAY_USDT_LKR)),
    createOfframp: jest.fn(),
    getOfframp: jest.fn(),
    verifyWebhookSignature: jest.fn(
      (...args: Parameters<CeyPayService['verifyWebhookSignature']>) =>
        realCeyPay.verifyWebhookSignature(...args),
    ),
  };
  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    presignUpload: jest.fn(),
    presignDownload: jest.fn(),
    head: jest.fn(),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // 24h change only (display); prices never come from CoinMarketCap
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
    .overrideProvider(CeyPayService)
    .useValue(ceyPay)
    .overrideProvider(R2StorageService)
    .useValue(storage)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();

  // Crons are triggered explicitly by the tests, never on a timer.
  const scheduler = app.get(SchedulerRegistry);
  scheduler.getCronJobs().forEach((job) => void job.stop());

  // BTC/USD comes from Ceylon Cash's FX API - pin it. (USDT/LKR comes from
  // the CeyPay mock's quotes, see quoteAt.)
  jest
    .spyOn(app.get(BitcoinPriceService), 'getBtcUsd')
    .mockResolvedValue(BTC_USD);
  const notifyUser = jest
    .spyOn(app.get(TelegramLoggerService), 'notifyUser')
    .mockResolvedValue(true);

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
      const rows: { payhere_pay_id: string; gross_amount: string | null }[] =
        await knex('transaction')
          .select('payhere_pay_id', 'gross_amount')
          .where({ payhere_sub_id, status: 'SUCCESS' });
      return rows.map((r) => ({
        payment_id: r.payhere_pay_id,
        status: 'RECEIVED',
        amount: r.gross_amount,
        order_id: null,
      }));
    });

  // Same for one-off checkouts (Retrieval API, by order_id)
  const payHereOrderPayments = jest
    .spyOn(app.get(PayHereService), 'getPaymentsByOrderId')
    .mockImplementation(async (payhere_order_id: string) => {
      const rows: { payhere_pay_id: string; gross_amount: string | null }[] =
        await knex('transaction')
          .select('payhere_pay_id', 'gross_amount')
          .where({ payhere_order_id, status: 'SUCCESS' });
      return rows.map((r) => ({
        payment_id: r.payhere_pay_id,
        status: 'RECEIVED',
        amount: r.gross_amount,
        order_id: payhere_order_id,
      }));
    });

  const jwt = app.get(JwtService);
  return {
    app,
    knex,
    bitcoinDeepa,
    didit,
    ceyPay,
    storage,
    notifyUser,
    payHereCancel,
    payHerePayments,
    payHereOrderPayments,
    tokenFor: (userId) => jwt.sign({ id: userId, username: `u${userId}` }),
    close: () => app.close(),
  };
}

/** Wipe app tables and Redis, then insert the base fixtures. */
export async function resetData(ctx: TestContext): Promise<void> {
  const { knex, app } = ctx;
  await knex.raw(
    'TRUNCATE sell_order, user_bank_account, "transaction", subscription, payhere_order, "user", package, admin_user, admin_verification RESTART IDENTITY CASCADE',
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
      kyc_full_name: 'Test User',
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
  resetSellMocks(ctx);
}

/** A CeyPay getQuote mock at a fixed USDT/LKR rate. */
export const quoteAt = (rateUsdtLkr: number) => (amountUsdt: string) =>
  Promise.resolve({
    fxLockId: randomUUID(),
    rateUsdtLkr,
    amountUsdt: Number(amountUsdt),
    amountLkr: Math.round(Number(amountUsdt) * rateUsdtLkr * 100) / 100,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

/** Default CeyPay / R2 / wallet behaviour for the sell flow. */
export function resetSellMocks(ctx: TestContext): void {
  const { ceyPay, storage, bitcoinDeepa } = ctx;
  ceyPay.getBanks.mockResolvedValue(BANKS);
  ceyPay.upsertUser.mockImplementation((externalUserId: string) =>
    Promise.resolve({ userId: randomUUID(), externalUserId }),
  );
  ceyPay.addBankAccount.mockImplementation(
    (
      _userId: string,
      a: { bankCode: number; accountNumber: string; accountName: string },
    ) => Promise.resolve({ userBankId: randomUUID(), ...a, bankName: 'Bank' }),
  );
  ceyPay.getQuote.mockImplementation(quoteAt(CEYPAY_USDT_LKR));
  ceyPay.createOfframp.mockImplementation((body: { externalRef: string }) =>
    Promise.resolve({
      paymentId: randomUUID(),
      status: 'PENDING',
      externalRef: body.externalRef,
    }),
  );
  storage.presignUpload.mockImplementation((key: string) =>
    Promise.resolve(`https://r2.test/${key}?X-Amz-Signature=put`),
  );
  storage.presignDownload.mockImplementation((key: string) =>
    Promise.resolve(`https://r2.test/${key}?X-Amz-Signature=get`),
  );
  storage.head.mockResolvedValue({
    size: 120_000,
    contentType: 'application/pdf',
  });
  bitcoinDeepa.collectFunds.mockResolvedValue({ success: true });
  bitcoinDeepa.getUserBalance.mockResolvedValue({
    success: true,
    balance: 0,
    balance_lkr: '0.00',
  });
}

/** Headers + raw body for a CeyPay webhook signed like CeyPay does. */
export function ceypayWebhook(
  body: Record<string, unknown>,
  timestamp = Date.now(),
) {
  const raw = JSON.stringify(body);
  return {
    raw,
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Timestamp': String(timestamp),
      'X-Webhook-Signature': sign(
        null,
        Buffer.from(`${timestamp}${raw}`),
        process.env.TEST_CEYPAY_WEBHOOK_PRIVATE_KEY!,
      ).toString('base64'),
    },
  };
}

const md5U = (s: string) =>
  createHash('md5').update(s).digest('hex').toUpperCase();

/** A PayHere notify_url payload signed with the test merchant secret. */
export function payhereNotification(fields: {
  order_id: string;
  payment_id: string;
  /** Leave out for a one-off (one-time buy) checkout */
  subscription_id?: string;
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
