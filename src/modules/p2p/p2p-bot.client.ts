import { Injectable, Logger } from '@nestjs/common';
import type { KeyObject } from 'crypto';
import axios from 'axios';
import {
  loadEd25519Key,
  P2P_SIGNING_VERSION,
  sha256hex,
  signBotRequest,
} from '../bitcoindeepa/bot-signer';

/** The user's Telegram credential, forwarded unchanged: it names the sender */
export type P2pCredential =
  | { kind: 'initData'; value: string }
  | { kind: 'idToken'; value: string };

export interface P2pBotResponse {
  status: number;
  /** Parsed JSON, or the raw text (e.g. a plain-text "Access denied") */
  body: unknown;
}

/** The bot rejects P2P bodies over 16 KiB */
const MAX_BODY_BYTES = 16 * 1024;
/** Internal sends run synchronously in the request */
const SEND_TIMEOUT_MS = 60_000;

/**
 * The bot's /api/v1/p2p API, signed with the P2P key (not the DCA wallet's
 * send key): BDB-P2P-ED25519-V1 over method, path, query, timestamp, nonce,
 * sha256(credential header value) and sha256(body). No X-Wallet-ID: the
 * sender is whoever the credential names.
 */
@Injectable()
export class P2pBotClient {
  private readonly logger = new Logger(P2pBotClient.name);
  private readonly apiUrl = process.env.BITCOINDEEPA_API_URL || '';
  private readonly timeout = parseInt(
    process.env.BITCOINDEEPA_TIMEOUT || '10000',
    10,
  );
  private readonly key: KeyObject | null = loadEd25519Key(
    process.env.BITCOINDEEPA_P2P_PRIVATE_KEY_PEM,
    'BITCOINDEEPA_P2P_PRIVATE_KEY_PEM',
    this.logger,
  );

  constructor() {
    if (process.env.P2P_ENABLED !== 'false' && !this.key) {
      this.logger.warn(
        'P2P is on but BITCOINDEEPA_P2P_PRIVATE_KEY_PEM is not set (or invalid): /p2p answers 503',
      );
    }
  }

  isConfigured(): boolean {
    return !!(this.apiUrl && this.key);
  }

  /**
   * One signed call. Any HTTP answer is returned (the caller maps it); only
   * "no answer" (timeout, network) throws. The body is serialized once and
   * those exact bytes are hashed and sent - the bot also rejects unknown
   * fields, so callers pass exactly the documented ones.
   */
  async request(
    method: 'GET' | 'POST',
    path: string,
    credential: P2pCredential,
    body?: Record<string, unknown>,
  ): Promise<P2pBotResponse> {
    if (!this.key) throw new Error('P2P API is not configured');
    const raw = body ? JSON.stringify(body) : '';
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw new Error('P2P request body is over 16 KiB');
    }
    const signed = signBotRequest({
      version: P2P_SIGNING_VERSION,
      method,
      pathWithQuery: path,
      hashedLines: [sha256hex(credential.value), sha256hex(raw)],
      key: this.key,
    });
    const response = await axios.request<unknown>({
      method,
      url: `${this.apiUrl}${path}`,
      data: body ? raw : undefined,
      // The signed bytes must be the sent bytes
      transformRequest: [(data: unknown) => data],
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        [credential.kind === 'initData'
          ? 'X-Telegram-Init-Data'
          : 'X-Telegram-ID-Token']: credential.value,
        ...signed,
      },
      timeout: path.endsWith('/send') ? SEND_TIMEOUT_MS : this.timeout,
    });
    return { status: response.status, body: response.data };
  }
}
