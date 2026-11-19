import { createHash } from 'crypto';
import {
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
    expect([...matchSalePayments(rows, orders)]).toEqual([0]);
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
    expect([...matchSalePayments(rows, orders)].sort()).toEqual([0, 1]);
  });
});
