import type { CollectRequest } from '../bitcoindeepa/bitcoindeepa.service';
import { CollectState } from './sell.constants';
import { toCollectState } from './sell.service';

const request = (status: string, transferStatus?: string): CollectRequest =>
  ({
    id: 'col-1',
    status,
    paid: false,
    amount: 1000,
    ...(transferStatus
      ? { transfer: { id: 'p2p-col-1', status: transferStatus } }
      : {}),
  }) as CollectRequest;

describe('toCollectState', () => {
  it('uses the request status until approved, then the transfer status', () => {
    expect(toCollectState(request('pending'))).toBe(CollectState.PENDING);
    expect(toCollectState(request('declined'))).toBe(CollectState.DECLINED);
    expect(toCollectState(request('approved', 'awaiting_confirmation'))).toBe(
      CollectState.AWAITING_CONFIRMATION,
    );
    expect(toCollectState(request('approved', 'completed'))).toBe(
      CollectState.COMPLETED,
    );
  });

  it('approved without a transfer yet is processing', () => {
    expect(toCollectState(request('approved'))).toBe(CollectState.PROCESSING);
  });

  it('a status the bot adds later is stored as processing, not rejected', () => {
    expect(toCollectState(request('approved', 'settling'))).toBe(
      CollectState.PROCESSING,
    );
    expect(toCollectState(request('on_hold'))).toBe(CollectState.PROCESSING);
  });
});
