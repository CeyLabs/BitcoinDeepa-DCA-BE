import { createHash } from 'crypto';
import {
  isPurchaseSettlement,
  matchSalePayments,
  parseAmount,
  TransactionService,
} from './transaction.service';
import { saleCollectMemo } from '../sell/sell.constants';
import { PayHereNotificationDto } from './dto/payhere-notification.dto';

const md5U = (s: string) =>
  createHash('md5').update(s).digest('hex').toUpperCase();

const SECRET = 'merchant-secret';

function signed(
  overrides: Partial<PayHereNotificationDto> = {},
): PayHereNotificationDto {
  const n = {
    merchant_id: '1220000',
    order_id: 'order-1',
    payment_id: '320000000001',
    subscription_id: '420000000001',
    payhere_amount: '1000.00',
    payhere_currency: 'LKR',
    status_code: '2',
    ...overrides,
  } as PayHereNotificationDto;
  n.md5sig =
    overrides.md5sig ??
    md5U(
      n.merchant_id +
        n.order_id +
        n.payhere_amount +
        n.payhere_currency +
        n.status_code +
        md5U(SECRET),
    );
  return n;
}

describe('parseAmount', () => {
  it.each([
    ['1000.00', 1000],
    ['1234.56', 1234.56],
    // parseFloat would read this as 1
    ['1,000.00', 1000],
    ['0.00', 0],
  ])('reads %s as %s', (value, amount) => {
    expect(parseAmount(value)).toBe(amount);
  });

  it.each(['', 'abc', '10.5LKR', '-5.00', 'NaN'])('refuses %p', (value) => {
    expect(parseAmount(value)).toBeNull();
  });
});

describe('TransactionService (pure logic)', () => {
  // Only the pure methods are exercised here; DB-backed flows are e2e.
  const service = new TransactionService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const original = process.env.PAYHERE_MERCHANT_SECRET;

  beforeEach(() => {
    process.env.PAYHERE_MERCHANT_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.PAYHERE_MERCHANT_SECRET = original;
  });

  describe('isValidPayHereSignature', () => {
    it('accepts a correctly signed notification', () => {
      expect(service.isValidPayHereSignature(signed())).toBe(true);
    });

    it('accepts a lowercase md5sig', () => {
      const n = signed();
      n.md5sig = n.md5sig.toLowerCase();
      expect(service.isValidPayHereSignature(n)).toBe(true);
    });

    it.each(['order_id', 'payhere_amount', 'status_code', 'merchant_id'])(
      'rejects when signed field %s is changed',
      (field) => {
        const n = signed();
        (n as unknown as Record<string, string>)[field] += '9';
        expect(service.isValidPayHereSignature(n)).toBe(false);
      },
    );

    it('ignores unsigned fields (custom_1/payment_id are not covered)', () => {
      const n = signed();
      n.custom_1 = 'someone-else';
      n.payment_id = 'other';
      expect(service.isValidPayHereSignature(n)).toBe(true);
    });

    it('rejects when the merchant secret is not configured', () => {
      delete process.env.PAYHERE_MERCHANT_SECRET;
      expect(service.isValidPayHereSignature(signed())).toBe(false);
    });

    it('rejects a garbage signature', () => {
      expect(service.isValidPayHereSignature(signed({ md5sig: 'BAD' }))).toBe(
        false,
      );
    });
  });

  describe('getPayHereStatusMapped', () => {
    it.each([
      ['2', 'SUCCESS'],
      ['0', 'PENDING'],
      ['-1', 'CANCELLED'],
      ['-2', 'FAILED'],
      ['-3', 'CHARGEBACK'],
      ['99', 'FAILED'],
    ])('maps %s to %s', (code, status) => {
      expect(service.getPayHereStatusMapped(code)).toBe(status);
    });
  });
});

describe('matchSalePayments', () => {
  const order = (id: string, sats: number, lkr: number, createdAt: string) => ({
    id,
    sats: String(sats),
    amount_lkr: String(lkr),
    created_at: createdAt,
  });
  const payment = (amount: number, lkr: number, time: string, extra = {}) => ({
    direction: 'outgoing',
    success: true,
    amount,
    memo: saleCollectMemo(lkr),
    time,
    ...extra,
  });

  it("marks the outgoing payment with the sale's sats and memo", () => {
    const rows = [
      payment(20000, 5792, '2026-11-19T10:01:00Z'),
      {
        direction: 'incoming',
        success: true,
        amount: 20000,
        time: '2026-11-19T10:02:00Z',
      },
    ];
    const orders = [order('a', 20000, 5792, '2026-11-19T10:00:00Z')];
    expect([...matchSalePayments(rows, orders)]).toEqual([[0, 'a']]);
  });

  it('ignores a transfer with another memo, amount, a failure or one made before the sale', () => {
    const orders = [order('a', 20000, 5792, '2026-11-19T10:00:00Z')];
    const rows = [
      payment(20000, 5792, '2026-11-19T10:01:00Z', { memo: 'Coffee' }),
      payment(19999, 5792, '2026-11-19T10:01:00Z'),
      payment(20000, 5792, '2026-11-19T10:01:00Z', { success: false }),
      payment(20000, 5792, '2026-11-19T09:59:00Z'),
    ];
    expect(matchSalePayments(rows, orders).size).toBe(0);
  });

  it("matches the bot's wrapped collect memo", () => {
    const orders = [order('a', 1478, 300.07, '2026-11-20T09:46:00Z')];
    const rows = [
      payment(1478, 300.07, '2026-11-20T09:47:00Z', {
        memo: `💰 Collect by @BitcoinDeepaDCA from @naween_95. Memo: ${saleCollectMemo(300.07)}`,
      }),
    ];
    expect([...matchSalePayments(rows, orders)]).toEqual([[0, 'a']]);
  });

  it('matches by payment hash first, whatever the memo says', () => {
    const orders = [
      {
        ...order('a', 20000, 5792, '2026-11-19T10:00:00Z'),
        bot_payment_hash: 'h-a',
      },
      {
        ...order('b', 20000, 5792, '2026-11-19T11:00:00Z'),
        bot_payment_hash: 'h-b',
      },
    ];
    const rows = [
      // Both after b was created: by memo alone, the first would go to b
      payment(20000, 5792, '2026-11-19T11:01:00Z', {
        payment_hash: 'h-a',
        memo: 'anything',
      }),
      payment(20000, 5792, '2026-11-19T11:02:00Z', { payment_hash: 'h-b' }),
    ];
    expect([...matchSalePayments(rows, orders)]).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
  });

  it('gives two equal sales one payment each', () => {
    const orders = [
      order('a', 20000, 5792, '2026-11-19T10:00:00Z'),
      order('b', 20000, 5792, '2026-11-19T11:00:00Z'),
    ];
    const rows = [
      payment(20000, 5792, '2026-11-19T11:01:00Z'),
      payment(20000, 5792, '2026-11-19T10:01:00Z'),
      payment(20000, 5792, '2026-11-19T12:00:00Z'), // a third: no sale left
    ];
    expect([...matchSalePayments(rows, orders).keys()].sort()).toEqual([0, 1]);
  });
});

describe('isPurchaseSettlement', () => {
  const ok = { amount: 500, success: true, payment_hash: 'h1' };

  it('needs the same sats', () => {
    expect(
      isPurchaseSettlement(
        { ...ok, amount: 499 },
        { settled: true, sats: 500 },
      ),
    ).toBe(false);
  });

  it('by memo alone when the purchase has no hash', () => {
    expect(isPurchaseSettlement(ok, { settled: true, sats: 500 })).toBe(true);
    expect(isPurchaseSettlement(ok, { settled: false, sats: 500 })).toBe(false);
  });

  it('by hash when the purchase has one: a copied memo is not enough', () => {
    const p = { settled: true, sats: 500, paymentHash: 'h1' };
    expect(isPurchaseSettlement(ok, p)).toBe(true);
    expect(isPurchaseSettlement({ ...ok, payment_hash: 'other' }, p)).toBe(
      false,
    );
    expect(isPurchaseSettlement({ amount: 500, success: true }, p)).toBe(false);
  });

  it('hides a failed attempt either way', () => {
    expect(
      isPurchaseSettlement(
        { amount: 500, success: false },
        { settled: false, sats: 500 },
      ),
    ).toBe(true);
  });
});
