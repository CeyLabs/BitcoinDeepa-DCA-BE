type IdVerification = {
  full_name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
};

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * The name Didit read from the member's ID, from a session decision (the
 * GET /v3/session/{id}/decision/ response or a webhook's `decision`).
 * V3 puts ID results in `id_verifications[]`, V2 in `id_verification`.
 */
export function verifiedNameFrom(decision: unknown): string | null {
  if (!decision || typeof decision !== 'object') return null;
  const d = decision as {
    id_verifications?: unknown;
    id_verification?: unknown;
  };
  const list: unknown[] = Array.isArray(d.id_verifications)
    ? (d.id_verifications as unknown[])
    : [];
  const candidates = [...list, d.id_verification].filter(
    (v): v is IdVerification => !!v && typeof v === 'object',
  );

  for (const id of candidates) {
    const full =
      text(id.full_name) ||
      [text(id.first_name), text(id.last_name)].filter(Boolean).join(' ');
    if (full) return full.replace(/\s+/g, ' ');
  }
  return null;
}
