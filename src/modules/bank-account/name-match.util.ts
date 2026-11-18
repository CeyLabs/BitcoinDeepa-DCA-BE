/**
 * Fuzzy match of a bank account holder name against the KYC name
 * (ported from CeyPay-BE ceyfi/utils/name-match.util.ts).
 *
 * Sri Lankan bank accounts are often held as initials + surname
 * ("K.A.D. PERERA") while ID documents carry the full name
 * ("KANKANAMGE AMAL DILSHAN PERERA"), so initials are matched against
 * the first letter of the KYC name's tokens.
 *
 * Only a hint for the admin reviewer - never an auto-approval.
 */

const TITLES = new Set([
  'MR',
  'MRS',
  'MS',
  'MISS',
  'DR',
  'REV',
  'PROF',
  'MASTER',
]);

export function tokenizeName(name: string): string[] {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z\s.]/g, ' ')
      // "K.A.D." / "K.A.D" → "K A D"
      .replace(/\./g, ' ')
      .split(/\s+/)
      .filter((t) => t && !TITLES.has(t))
  );
}

export interface NameMatchResult {
  isMatch: boolean;
  /** Share of account-name tokens explained by the KYC name (0..1) */
  score: number;
}

/**
 * An account name matches when every one of its tokens is explained by a
 * distinct KYC token (full word, or a single-letter initial of one), at least
 * one full word (not just initials) matches, and at least two tokens match.
 */
export function matchAccountName(
  accountName: string,
  kycName: string,
): NameMatchResult {
  const accountTokens = tokenizeName(accountName);
  const kycTokens = tokenizeName(kycName);
  if (accountTokens.length === 0 || kycTokens.length === 0) {
    return { isMatch: false, score: 0 };
  }

  const used = new Set<number>();
  let matched = 0;
  let fullWordMatches = 0;

  // Full words first so initials can't steal a token a full word needs
  const ordered = [...accountTokens].sort((a, b) => b.length - a.length);
  for (const token of ordered) {
    let idx = -1;
    if (token.length > 1) {
      idx = kycTokens.findIndex((k, i) => !used.has(i) && k === token);
      if (idx >= 0) fullWordMatches++;
    } else {
      idx = kycTokens.findIndex((k, i) => !used.has(i) && k.startsWith(token));
    }
    if (idx >= 0) {
      used.add(idx);
      matched++;
    }
  }

  const score = matched / accountTokens.length;
  const isMatch =
    score === 1 &&
    fullWordMatches >= 1 &&
    matched >= Math.min(2, kycTokens.length);
  return { isMatch, score: Math.round(score * 10000) / 10000 };
}
