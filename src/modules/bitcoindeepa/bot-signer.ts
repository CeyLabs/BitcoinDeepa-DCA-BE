import type { Logger } from '@nestjs/common';
import {
  createHash,
  createPrivateKey,
  type KeyObject,
  randomBytes,
  sign,
} from 'crypto';

/**
 * Ed25519 request signing shared by the bot's APIs. Each API signs its own
 * first line, so a signature for one can't be replayed on the other:
 * - send API (our DCA wallet): BDB-SEND-ED25519-V1 ... sha256hex(body)
 * - P2P login (POST /api/v1/init only): BDB-P2P-ED25519-V1 ... sha256hex(credential), sha256hex(body)
 * - P2P calls for a linked user: BDB-P2P-ED25519-V2 ... telegramId, sha256hex(body)
 */
export const SEND_SIGNING_VERSION = 'BDB-SEND-ED25519-V1';
export const P2P_SIGNING_VERSION = 'BDB-P2P-ED25519-V1';
export const P2P_SIGNING_VERSION_V2 = 'BDB-P2P-ED25519-V2';

export const sha256hex = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

/**
 * An Ed25519 private key from a PEM env value. Railway stores multi-line
 * values fine, but a single line with literal "\n" is accepted too. Null (and
 * one error log naming `envName`) when unset, unparsable or not Ed25519.
 */
export function loadEd25519Key(
  pem: string | undefined,
  envName: string,
  logger: Pick<Logger, 'error'>,
): KeyObject | null {
  if (!pem) return null;
  try {
    const key = createPrivateKey(pem.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'ed25519') {
      logger.error(
        `${envName} is a ${key.asymmetricKeyType} key, not Ed25519: calls that need it are disabled`,
      );
      return null;
    }
    return key;
  } catch (error) {
    logger.error(
      `${envName} can't be parsed (${String(error)}): calls that need it are disabled`,
    );
    return null;
  }
}

export interface SignedHeaders {
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Signature': string;
}

/**
 * Sign one request: `[version, METHOD, PATH, QUERY, TIMESTAMP, NONCE,
 * ...hashedLines].join('\n')` (no trailing newline). `hashedLines` are the
 * API's trailing lines, in order (hex hashes, or V2's Telegram ID). Every call gets a fresh timestamp and
 * nonce: the bot rejects a reused nonce, so retries must be signed again.
 */
export function signBotRequest(params: {
  version: string;
  method: 'GET' | 'POST';
  pathWithQuery: string;
  hashedLines: string[];
  key: KeyObject;
}): SignedHeaders {
  const [path, query = ''] = params.pathWithQuery.split('?');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const message = [
    params.version,
    params.method,
    path,
    query,
    timestamp,
    nonce,
    ...params.hashedLines,
  ].join('\n');
  return {
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': sign(null, Buffer.from(message), params.key).toString(
      'base64',
    ),
  };
}
