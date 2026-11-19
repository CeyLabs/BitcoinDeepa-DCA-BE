import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { createHash, generateKeyPairSync, verify } from 'crypto';
import { BitcoinDeepaService } from './bitcoindeepa.service';

const request = jest.spyOn(axios, 'request');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The config of the n-th axios.request call */
const call = (n = 0) => request.mock.calls[n][0] as AxiosRequestConfig;
const headersOf = (config: AxiosRequestConfig) =>
  config.headers as Record<string, string>;

/** Rebuild the signing string from what was sent and verify it with the public key */
function verifySigned(config: AxiosRequestConfig): boolean {
  const h = headersOf(config);
  const url = new URL(config.url!);
  const raw = (config.data as string | undefined) ?? '';
  const message = [
    'BDB-SEND-ED25519-V1',
    config.method,
    url.pathname,
    url.search.replace(/^\?/, ''),
    h['X-Timestamp'],
    h['X-Nonce'],
    createHash('sha256').update(raw).digest('hex'),
  ].join('\n');
  return verify(
    null,
    Buffer.from(message),
    publicKey,
    Buffer.from(h['X-Signature'], 'base64'),
  );
}

/** A real AxiosError, as axios rejects with on a non-2xx response */
const apiError = (status: number, error: string) =>
  Object.assign(new AxiosError('Request failed'), {
    response: { status, data: { success: false, error } },
  });

describe('BitcoinDeepaService', () => {
  let service: BitcoinDeepaService;

  beforeEach(() => {
    process.env.BITCOINDEEPA_API_URL = 'https://bd.test';
    process.env.BITCOINDEEPA_WALLET_ID = 'BiccoindeepaDSATest';
    process.env.BITCOINDEEPA_SEND_PRIVATE_KEY_PEM = PEM;
    delete process.env.BITCOINDEEPA_COLLECT_MOCK;
    service = new BitcoinDeepaService();
    request.mockReset();
  });
  afterAll(() => request.mockRestore());

  describe('Ed25519 signing', () => {
    it('signs method, path, query, timestamp, nonce and the exact body bytes', async () => {
      request.mockResolvedValue({ status: 200, data: { success: true } });
      await service.transferFunds(1000, '42', 'memo');

      const config = call();
      expect(config.method).toBe('POST');
      expect(config.url).toBe('https://bd.test/api/v1/send');
      expect(JSON.parse(config.data as string)).toEqual({
        amount: 1000,
        to: '42',
        memo: 'memo',
      });
      const h = headersOf(config);
      expect(h['X-Wallet-ID']).toBe('BiccoindeepaDSATest');
      expect(h['X-Timestamp']).toMatch(/^\d{10}$/);
      expect(h['X-Nonce']).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(h['X-HMAC-Signature']).toBeUndefined();
      expect(verifySigned(config)).toBe(true);
      // axios must send the signed string as-is, not re-serialize it
      expect(config.transformRequest).toBeDefined();
    });

    it('signs a GET with an empty body hash', async () => {
      request.mockResolvedValue({
        status: 200,
        data: { id: 'pending-1', status: 'pending' },
      });
      await service.getSendStatus('pending-1');
      const config = call();
      expect(config.method).toBe('GET');
      expect(config.url).toBe('https://bd.test/api/v1/send/status/pending-1');
      expect(config.data).toBeUndefined();
      expect(verifySigned(config)).toBe(true);
    });

    it('uses a new nonce on every call, retries included', async () => {
      request.mockResolvedValue({ status: 200, data: { success: true } });
      await service.transferFunds(1, '42', 'same-memo');
      await service.transferFunds(1, '42', 'same-memo');
      expect(headersOf(call(0))['X-Nonce']).not.toBe(
        headersOf(call(1))['X-Nonce'],
      );
    });

    it('gives /send the long timeout and other calls the short one', async () => {
      request.mockResolvedValue({ status: 200, data: { success: true } });
      await service.transferFunds(1, '42', 'm');
      await service.getUserBalance(42);
      expect(call(0).timeout).toBe(95000);
      expect(call(1).timeout).toBe(10000);
    });

    it('accepts a one-line PEM with literal \\n', () => {
      process.env.BITCOINDEEPA_SEND_PRIVATE_KEY_PEM = PEM.replace(/\n/g, '\\n');
      expect(new BitcoinDeepaService().isConfigured()).toBe(true);
    });

    it.each([
      ['no URL', 'BITCOINDEEPA_API_URL', ''],
      ['no wallet id', 'BITCOINDEEPA_WALLET_ID', ''],
      ['no key', 'BITCOINDEEPA_SEND_PRIVATE_KEY_PEM', ''],
      ['an unparseable key', 'BITCOINDEEPA_SEND_PRIVATE_KEY_PEM', 'not a pem'],
    ])('is not configured with %s', (_, name, value) => {
      process.env[name] = value;
      expect(new BitcoinDeepaService().isConfigured()).toBe(false);
    });

    it('rejects a non-Ed25519 key', () => {
      const { privateKey: rsa } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      process.env.BITCOINDEEPA_SEND_PRIVATE_KEY_PEM = rsa
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      expect(new BitcoinDeepaService().isConfigured()).toBe(false);
    });
  });

  describe('transferFunds results', () => {
    it('returns the API response on success', async () => {
      request.mockResolvedValue({
        status: 200,
        data: { success: true, transaction_id: 't1' },
      });
      await expect(service.transferFunds(1, '42', 'm')).resolves.toEqual({
        success: true,
        transaction_id: 't1',
      });
    });

    it('reads the approval id from a 202 awaiting_approval', async () => {
      request.mockResolvedValue({
        status: 202,
        data: {
          success: true,
          status: 'awaiting_approval',
          message:
            'Amount above the approval threshold. Transaction ID: pending-abc_123',
        },
      });
      await expect(
        service.transferFunds(150000, '42', 'm'),
      ).resolves.toMatchObject({
        success: false,
        awaiting_approval_id: 'pending-abc_123',
      });
    });

    it.each([
      ['a structured id field', { id: 'pending-9' }, 'pending-9'],
      ['a transaction_id field', { transaction_id: 'pending-8' }, 'pending-8'],
      [
        'trailing punctuation in the message',
        { message: 'Waiting for approval. Transaction ID: pending-abc.' },
        'pending-abc',
      ],
    ])('takes the approval id from %s', async (_, body, id) => {
      request.mockResolvedValue({
        status: 202,
        data: { status: 'awaiting_approval', ...body },
      });
      await expect(
        service.transferFunds(150000, '42', 'm'),
      ).resolves.toMatchObject({ awaiting_approval_id: id });
    });

    it('treats any other 202 (e.g. an invoice still routing) as an unknown outcome', async () => {
      request.mockResolvedValue({
        status: 202,
        data: { status: 'pending', payment_hash: 'h' },
      });
      await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
        success: false,
        outcome_unknown: true,
        failure: 'UNKNOWN',
      });
    });

    it('flags a timeout (no response) as an unknown outcome', async () => {
      request.mockRejectedValue(new Error('timeout of 95000ms exceeded'));
      await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
        success: false,
        outcome_unknown: true,
        failure: 'UNKNOWN',
      });
    });

    it.each([500, 502, 503, 504])(
      'flags a %i as an unknown outcome',
      async (status) => {
        request.mockRejectedValue(apiError(status, 'Server error'));
        await expect(
          service.transferFunds(1, '42', 'm'),
        ).resolves.toMatchObject({
          outcome_unknown: true,
          failure: 'UNKNOWN',
        });
      },
    );

    it('treats an "already completed" memo as done', async () => {
      request.mockRejectedValue(apiError(400, 'Memo already completed'));
      await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
        success: false,
        already_completed: true,
      });
    });

    it('classifies a low DCA-wallet balance', async () => {
      request.mockRejectedValue(apiError(400, 'Insufficient balance'));
      const result = await service.transferFunds(1, '42', 'm');
      expect(result).toMatchObject({
        success: false,
        message: 'Insufficient balance',
        failure: 'LOW_BALANCE',
      });
      expect(result.outcome_unknown).toBeUndefined();
    });

    it('classifies other 400s as rejected', async () => {
      request.mockRejectedValue(apiError(400, 'Recipient not found'));
      await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
        failure: 'REJECTED',
      });
    });

    it('classifies a 200 with success:false like a 400', async () => {
      request.mockResolvedValue({
        status: 200,
        data: { success: false, message: 'Not enough balance' },
      });
      await expect(service.transferFunds(1, '42', 'm')).resolves.toMatchObject({
        success: false,
        failure: 'LOW_BALANCE',
      });
    });

    it.each([401, 403])(
      'never reads a %i as a duplicate memo, whatever its message says',
      async (status) => {
        request.mockRejectedValue(apiError(status, 'Nonce already exists'));
        const result = await service.transferFunds(1, '42', 'm');
        expect(result).toMatchObject({ failure: 'AUTH' });
        expect(result.already_completed).toBeUndefined();
      },
    );

    it.each([401, 403])(
      'classifies a %i as an auth problem',
      async (status) => {
        request.mockRejectedValue(apiError(status, 'Invalid signature'));
        await expect(
          service.transferFunds(1, '42', 'm'),
        ).resolves.toMatchObject({
          failure: 'AUTH',
        });
      },
    );
  });

  describe('getSendStatus', () => {
    it('returns the approval status', async () => {
      request.mockResolvedValue({
        status: 200,
        data: { id: 'pending-1', status: 'executed', amount: 150000 },
      });
      await expect(service.getSendStatus('pending-1')).resolves.toMatchObject({
        status: 'executed',
      });
    });

    it('returns null when it cannot be read', async () => {
      request.mockRejectedValue(apiError(503, 'down'));
      await expect(service.getSendStatus('pending-1')).resolves.toBeNull();
    });

    it('returns NOT_FOUND for an id the bot does not know', async () => {
      request.mockRejectedValue(apiError(404, 'Not found'));
      await expect(service.getSendStatus('pending-x')).resolves.toBe(
        'NOT_FOUND',
      );
    });
  });

  describe('findTransferByMemo', () => {
    const tx = (memo: string, extra = {}) => ({
      id: 1,
      time: '2026-11-19T00:00:00Z',
      direction: 'incoming',
      amount: 100,
      memo,
      success: true,
      ...extra,
    });

    it('finds a successful incoming transfer with the memo', async () => {
      request.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          transactions: [tx('other'), tx('DCA (Ref: P1)')],
        },
      });
      await expect(
        service.findTransferByMemo(42, 'DCA (Ref: P1)'),
      ).resolves.toBe(true);
      expect(JSON.parse(call().data as string)).toEqual({
        telegram_id: 42,
        limit: 250,
        offset: 0,
      });
    });

    it('ignores outgoing or failed entries', async () => {
      request.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          transactions: [
            tx('m', { direction: 'outgoing' }),
            tx('m', { success: false }),
          ],
        },
      });
      await expect(service.findTransferByMemo(42, 'm')).resolves.toBe(false);
    });

    it('pages through full pages, then stops', async () => {
      const full = Array.from({ length: 250 }, () => tx('x'));
      request
        .mockResolvedValueOnce({
          status: 200,
          data: { success: true, transactions: full },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { success: true, transactions: [tx('m')] },
        });
      await expect(service.findTransferByMemo(42, 'm')).resolves.toBe(true);
      expect(JSON.parse(call(1).data as string)).toMatchObject({ offset: 250 });
    });

    it('returns null when the history cannot be read', async () => {
      request.mockRejectedValue(apiError(503, 'down'));
      await expect(service.findTransferByMemo(42, 'm')).resolves.toBeNull();
    });
  });

  describe('collectFunds (sell flow)', () => {
    it('posts a signed debit of the user to /api/v1/collect', async () => {
      request.mockResolvedValue({ status: 200, data: { success: true } });
      await service.collectFunds(5000, '42', 'sell:abc');
      const config = call();
      expect(config.url).toBe('https://bd.test/api/v1/collect');
      expect(JSON.parse(config.data as string)).toEqual({
        telegram_id: 42,
        amount: 5000,
        memo: 'sell:abc',
      });
      expect(verifySigned(config)).toBe(true);
    });

    it('treats a 500 as an unknown outcome (the debit may have happened)', async () => {
      request.mockRejectedValue(apiError(500, 'boom'));
      await expect(service.collectFunds(1, '42', 'm')).resolves.toMatchObject({
        outcome_unknown: true,
      });
    });

    it('with the mock on, succeeds without calling the bot', async () => {
      process.env.BITCOINDEEPA_COLLECT_MOCK = 'true';
      await expect(service.collectFunds(1, '42', 'm')).resolves.toMatchObject({
        success: true,
      });
      expect(request).not.toHaveBeenCalled();
    });
  });

  it('fetches bot transaction history with limit/offset', async () => {
    request.mockResolvedValue({
      status: 200,
      data: { success: true, count: 0, transactions: [] },
    });
    await service.getUserTransactions(42, 50, 100);
    expect(call().url).toBe('https://bd.test/api/v1/usertransactions');
    expect(JSON.parse(call().data as string)).toEqual({
      telegram_id: 42,
      limit: 50,
      offset: 100,
    });
  });

  it('returns a failure when the balance API fails', async () => {
    request.mockRejectedValue(apiError(503, 'down'));
    await expect(service.getUserBalance(42)).resolves.toMatchObject({
      success: false,
    });
  });

  it('refuses to call the bot when not configured', async () => {
    process.env.BITCOINDEEPA_SEND_PRIVATE_KEY_PEM = '';
    const unconfigured = new BitcoinDeepaService();
    await expect(
      unconfigured.transferFunds(1, '42', 'm'),
    ).resolves.toMatchObject({
      success: false,
      outcome_unknown: true,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
