import { kycIssuesFrom } from './kyc-issues.util';

describe('kycIssuesFrom', () => {
  it('lists V3 warnings per check', () => {
    expect(
      kycIssuesFrom({
        id_verifications: [
          {
            status: 'Declined',
            warnings: [
              {
                risk: 'DOCUMENT_EXPIRED',
                short_description: 'Document has expired',
              },
            ],
          },
        ],
        face_matches: [
          {
            status: 'Declined',
            warnings: [{ risk: 'LOW_FACE_MATCH_SIMILARITY' }],
          },
        ],
        liveness_checks: [{ status: 'Approved', warnings: [] }],
      }),
    ).toEqual([
      'ID: Document has expired',
      'Face match: LOW_FACE_MATCH_SIMILARITY',
    ]);
  });

  it('reads V2 single-object checks', () => {
    expect(
      kycIssuesFrom({
        liveness: { warnings: [{ long_description: 'Possible  spoof' }] },
      }),
    ).toEqual(['Liveness: Possible spoof']);
  });

  it('labels unknown checks from their key and drops duplicates', () => {
    expect(
      kycIssuesFrom({
        nfc_verifications: [{ warnings: [{ risk: 'X' }, { risk: 'X' }] }],
      }),
    ).toEqual(['Nfc verifications: X']);
  });

  it('caps the list', () => {
    const warnings = Array.from({ length: 13 }, (_, i) => ({ risk: `R${i}` }));
    const issues = kycIssuesFrom({ aml_screenings: [{ warnings }] });
    expect(issues).toHaveLength(11);
    expect(issues[10]).toBe('...and 3 more');
  });

  it('returns nothing for missing or odd decisions', () => {
    expect(kycIssuesFrom(undefined)).toEqual([]);
    expect(kycIssuesFrom('x')).toEqual([]);
    expect(
      kycIssuesFrom({ status: 'Declined', id_verifications: [null, 1] }),
    ).toEqual([]);
  });
});
