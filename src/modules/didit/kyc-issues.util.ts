/** Most issues listed in one alert; the rest are counted */
const MAX_ISSUES = 10;

const FEATURE_LABELS: Record<string, string> = {
  id_verification: 'ID',
  id_verifications: 'ID',
  liveness: 'Liveness',
  liveness_checks: 'Liveness',
  face_match: 'Face match',
  face_matches: 'Face match',
  aml: 'AML',
  aml_screenings: 'AML',
  ip_analysis: 'IP',
  ip_analyses: 'IP',
  phone: 'Phone',
  phone_verifications: 'Phone',
  email: 'Email',
  email_verifications: 'Email',
  poa: 'Proof of address',
  poa_verifications: 'Proof of address',
  database_validation: 'Database check',
  database_validations: 'Database check',
};

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

const label = (key: string): string =>
  FEATURE_LABELS[key] ??
  key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * What went wrong in a Didit session, from its decision (webhook `decision`
 * or GET /v3/session/{id}/decision/): each check's warnings, as
 * "Feature: description". V3 puts each check in an array (`id_verifications`,
 * `liveness_checks`, ...), V2 in a single object (`id_verification`, ...).
 * Unknown shapes give an empty list, never an error.
 */
export function kycIssuesFrom(decision: unknown): string[] {
  if (!decision || typeof decision !== 'object') return [];

  const issues = new Set<string>();
  for (const [key, value] of Object.entries(decision)) {
    const checks: unknown[] = Array.isArray(value) ? value : [value];
    for (const check of checks) {
      if (!check || typeof check !== 'object') continue;
      const { warnings } = check as { warnings?: unknown };
      if (!Array.isArray(warnings)) continue;
      for (const warning of warnings) {
        if (!warning || typeof warning !== 'object') continue;
        const w = warning as Record<string, unknown>;
        const description =
          text(w.short_description) || text(w.long_description) || text(w.risk);
        if (description) issues.add(`${label(key)}: ${description}`);
      }
    }
  }

  const list = [...issues];
  if (list.length <= MAX_ISSUES) return list;
  return [
    ...list.slice(0, MAX_ISSUES),
    `...and ${list.length - MAX_ISSUES} more`,
  ];
}
