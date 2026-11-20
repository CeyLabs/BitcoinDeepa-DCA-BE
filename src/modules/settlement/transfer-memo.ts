import type { PurchaseKind } from '../transaction/transaction.service';

/**
 * The memo is the transfer's idempotency key on the BitcoinDeepa API (a
 * repeated memo is answered "already completed"), so a payment must be sent
 * with the same memo on every attempt. New payments store it in
 * `transaction.transfer_memo` when they are created.
 */
export function transferMemo(
  payhere_pay_id: string,
  kind: PurchaseKind = 'RECURRING',
): string {
  return kind === 'ONE_TIME'
    ? `One-time BTC purchase (Ref: ${payhere_pay_id})`
    : `DCA purchase (Ref: ${payhere_pay_id})`;
}

/**
 * The memo the previous release sent (its `generateTransferMemo`):
 * `<package name> DCA plan (Ref: <id>)`, or `DCA Purchase (Ref: <id>)` when the
 * subscription has no package. Payments with no stored memo were created by
 * that release and may already have been sent with it, so they keep it.
 */
export function legacyTransferMemo(
  payhere_pay_id: string,
  packageName: string | null | undefined,
): string {
  return packageName
    ? `${packageName} DCA plan (Ref: ${payhere_pay_id})`
    : `DCA Purchase (Ref: ${payhere_pay_id})`;
}
