/**
 * Bitcoin Deepa @usernames: how members find each other to send sats.
 * Separate from the Telegram username. Rules match CeyFi's handles
 * (CeyPay-BE src/modules/ceyfi/ceyfi.constants.ts); the TMA keeps a copy in
 * src/lib/username.ts.
 */

/** 3-20 chars: lower-case letters, digits and underscores, starting with a letter */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

export const USERNAME_RULE =
  'Use 3-20 letters, digits or underscores, starting with a letter';

/** "@Kasun_77 " → "kasun_77" (what we store and look up) */
export const normalizeUsername = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.trim().replace(/^@+/, '').toLowerCase()
    : value;

/**
 * Usernames nobody can claim: our brands, partners, banks and words that
 * would make someone look official. Compared against the normalized name.
 */
export const RESERVED_USERNAMES = new Set<string>([
  'admin',
  'administrator',
  'support',
  'help',
  'helpdesk',
  'official',
  'verified',
  'system',
  'root',
  'staff',
  'team',
  'security',
  'compliance',
  'finance',
  'payments',
  'payment',
  'pay',
  'send',
  'receive',
  'refund',
  'refunds',
  'wallet',
  'bank',
  'treasury',
  'ceypay',
  'ceylon',
  'ceyloncash',
  'ceylon_cash',
  'ceylabs',
  'binance',
  'binancepay',
  'bybit',
  'bybitpay',
  'kucoin',
  'kucoinpay',
  'okx',
  'coinbase',
  'tether',
  'usdt',
  'privy',
  'didit',
  'myreload',
  'paygo',
  'lankaqr',
  'cefts',
  'cbsl',
  'centralbank',
  'central_bank',
  'boc',
  'bankofceylon',
  'peoples_bank',
  'peoplesbank',
  'sampath',
  'sampathbank',
  'commercial',
  'combank',
  'hnb',
  'hatton',
  'ndb',
  'dfcc',
  'seylan',
  'nations_trust',
  'nationstrust',
  'ntb',
  'nsb',
  'panasia',
  'pan_asia',
  'unionbank',
  'amana',
  'cargills',
  'hsbc',
  'citi',
  'citibank',
  'standardchartered',
  'dialog',
  'mobitel',
  'hutch',
  'airtel',
  'slt',
  'ceb',
  'leco',
  'nwsdb',
  'null',
  'undefined',
  'anonymous',
  'unknown',
  'me',
  'you',
  'user',
  'test',
  'bitcoindeepa',
  'bitcoin_deepa',
  'deepa',
  'bitcoin',
  'btc',
  'sats',
  'satoshi',
  'bdbot',
  'bitcoindeepabot',
  'lightning',
  'paypal',
  'payhere',
  'plans',
  'tasks',
  'news',
]);

/** Why a (normalized) username can't be claimed, or null if it can */
export function usernameUnavailableReason(
  username: string,
  taken: boolean,
): string | null {
  if (!USERNAME_PATTERN.test(username)) return USERNAME_RULE;
  if (RESERVED_USERNAMES.has(username)) return 'This username is reserved';
  if (taken) return 'This username is taken';
  return null;
}

/**
 * A member's name as a sender sees it: the first word and the second's
 * initial, e.g. "Nimal Silva Fernando" → "Nimal S.". Enough to confirm the
 * right person without showing the full name to anyone who guesses a
 * username. Leading initials ("K.A.D. Perera") are skipped.
 */
export function maskDisplayName(
  name: string | null | undefined,
): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const isInitials = (p: string) =>
    (/^([A-Za-z]\.?)+$/.test(p) && p.replace(/\./g, '').length <= 1) ||
    /^([A-Za-z]\.)+$/.test(p);
  const [first, second] = parts.some((p) => !isInitials(p))
    ? parts.filter((p) => !isInitials(p))
    : parts;
  return second ? `${first} ${second.charAt(0).toUpperCase()}.` : first;
}
