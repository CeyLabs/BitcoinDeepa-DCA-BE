import { createHash, generateKeyPairSync, verify } from 'crypto';
import {
  loadEd25519Key,
  P2P_SIGNING_VERSION,
  SEND_SIGNING_VERSION,
  sha256hex,
  signBotRequest,
} from './bot-signer';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('signBotRequest', () => {
  it('signs the 8-line P2P string: credential hash, then body hash', () => {
    const body = '{"to":"bob"}';
    const cred = 'query_id=1&user=%7B%22id%22%3A42%7D&auth_date=1&hash=x';
    const h = signBotRequest({
      version: P2P_SIGNING_VERSION,
      method: 'POST',
      pathWithQuery: '/api/v1/p2p/resolve',
      hashedLines: [sha256hex(cred), sha256hex(body)],
      key: privateKey,
    });
    const message = [
      'BDB-P2P-ED25519-V1',
      'POST',
      '/api/v1/p2p/resolve',
      '',
      h['X-Timestamp'],
      h['X-Nonce'],
      hex(cred),
      hex(body),
    ].join('\n');
    expect(
      verify(
        null,
        Buffer.from(message),
        publicKey,
        Buffer.from(h['X-Signature'], 'base64'),
      ),
    ).toBe(true);
    expect(h['X-Nonce']).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it('signs the query separately from the path, and a send-API string', () => {
    const h = signBotRequest({
      version: SEND_SIGNING_VERSION,
      method: 'GET',
      pathWithQuery: '/api/v1/referral/lookup?code=PROMO',
      hashedLines: [sha256hex('')],
      key: privateKey,
    });
    const message = [
      'BDB-SEND-ED25519-V1',
      'GET',
      '/api/v1/referral/lookup',
      'code=PROMO',
      h['X-Timestamp'],
      h['X-Nonce'],
      hex(''),
    ].join('\n');
    expect(
      verify(
        null,
        Buffer.from(message),
        publicKey,
        Buffer.from(h['X-Signature'], 'base64'),
      ),
    ).toBe(true);
  });

  it('uses a new nonce every time', () => {
    const sign = () =>
      signBotRequest({
        version: P2P_SIGNING_VERSION,
        method: 'GET',
        pathWithQuery: '/x',
        hashedLines: [],
        key: privateKey,
      })['X-Nonce'];
    expect(sign()).not.toBe(sign());
  });
});

describe('loadEd25519Key', () => {
  const logger = { error: jest.fn() };
  beforeEach(() => logger.error.mockClear());

  it('loads a PEM, also with literal \\n', () => {
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(loadEd25519Key(pem, 'K', logger)).not.toBeNull();
    expect(
      loadEd25519Key(pem.replace(/\n/g, '\\n'), 'K', logger),
    ).not.toBeNull();
  });

  it('returns null and names the env var for a bad or non-Ed25519 key', () => {
    expect(loadEd25519Key('nope', 'MY_KEY', logger)).toBeNull();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(loadEd25519Key(rsa, 'MY_KEY', logger)).toBeNull();
    expect(
      logger.error.mock.calls.every(([m]) => String(m).startsWith('MY_KEY ')),
    ).toBe(true);
    expect(loadEd25519Key(undefined, 'MY_KEY', logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
