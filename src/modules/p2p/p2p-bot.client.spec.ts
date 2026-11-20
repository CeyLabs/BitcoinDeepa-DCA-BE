import { createHash, generateKeyPairSync, verify } from 'crypto';
import axios from 'axios';
import { P2pBotClient } from './p2p-bot.client';

jest.mock('axios');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('P2pBotClient (bot docs/dca-backend-integration.md §5)', () => {
  const request = axios.request as jest.Mock;
  let client: P2pBotClient;

  beforeAll(() => {
    process.env.BITCOINDEEPA_API_URL = 'https://bot.test';
    process.env.BITCOINDEEPA_PRIVATE_KEY_PEM = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    client = new P2pBotClient();
  });
  afterAll(() => {
    delete process.env.BITCOINDEEPA_API_URL;
    delete process.env.BITCOINDEEPA_PRIVATE_KEY_PEM;
  });
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ status: 200, data: {} });
  });

  const sent = () =>
    request.mock.calls[0][0] as {
      url: string;
      data?: string;
      headers: Record<string, string>;
    };
  const verifies = (message: string, signature: string) =>
    verify(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(signature, 'base64'),
    );

  it('V2: names the user with X-BDB-User, signs it on line 7, sends no Telegram header', async () => {
    const body = {
      to_telegram_id: 222,
      amount: 1000,
      idempotency_key: 'k-1234567',
    };
    await client.request(
      'POST',
      '/api/v1/p2p/send',
      { kind: 'user', telegramId: '111' },
      body,
    );

    const { url, data, headers } = sent();
    expect(url).toBe('https://bot.test/api/v1/p2p/send');
    expect(headers['X-BDB-User']).toBe('111');
    expect(headers['X-Telegram-Init-Data']).toBeUndefined();
    expect(headers['X-Telegram-ID-Token']).toBeUndefined();
    // Same text as the bot's P2PSigningStringV2
    const message = [
      'BDB-P2P-ED25519-V2',
      'POST',
      '/api/v1/p2p/send',
      '',
      headers['X-Timestamp'],
      headers['X-Nonce'],
      '111',
      hex(data as string),
    ].join('\n');
    expect(data).toBe(JSON.stringify(body));
    expect(verifies(message, headers['X-Signature'])).toBe(true);
  });

  it('V2 GET signs the empty body', async () => {
    await client.request('GET', '/api/v1/p2p/me', {
      kind: 'user',
      telegramId: '111',
    });
    const { headers } = sent();
    const message = [
      'BDB-P2P-ED25519-V2',
      'GET',
      '/api/v1/p2p/me',
      '',
      headers['X-Timestamp'],
      headers['X-Nonce'],
      '111',
      hex(''),
    ].join('\n');
    expect(verifies(message, headers['X-Signature'])).toBe(true);
  });

  it('login (init): V1 with the credential header and its hash, no X-BDB-User', async () => {
    await client.request(
      'POST',
      '/api/v1/init',
      { kind: 'idToken', value: 'a.b.c' },
      {},
    );
    const { headers, data } = sent();
    expect(headers['X-Telegram-ID-Token']).toBe('a.b.c');
    expect(headers['X-BDB-User']).toBeUndefined();
    const message = [
      'BDB-P2P-ED25519-V1',
      'POST',
      '/api/v1/init',
      '',
      headers['X-Timestamp'],
      headers['X-Nonce'],
      hex('a.b.c'),
      hex(data as string),
    ].join('\n');
    expect(verifies(message, headers['X-Signature'])).toBe(true);
  });

  it('refuses a non-numeric user id without calling the bot', async () => {
    await expect(
      client.request('GET', '/api/v1/p2p/me', {
        kind: 'user',
        telegramId: '1\n2',
      }),
    ).rejects.toThrow(/numeric/);
    expect(request).not.toHaveBeenCalled();
  });
});
