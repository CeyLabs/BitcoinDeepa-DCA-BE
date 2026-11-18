import { verifiedNameFrom } from './verified-name.util';

describe('verifiedNameFrom', () => {
  it('reads the V3 id_verifications array', () => {
    expect(
      verifiedNameFrom({
        id_verifications: [
          {
            first_name: 'Freja',
            last_name: 'Nielsen',
            full_name: 'Freja Nielsen',
          },
        ],
      }),
    ).toBe('Freja Nielsen');
  });

  it('falls back to first + last name, and to the V2 field', () => {
    expect(
      verifiedNameFrom({
        id_verifications: [{ first_name: ' Amal ', last_name: 'Perera' }],
      }),
    ).toBe('Amal Perera');
    expect(
      verifiedNameFrom({ id_verification: { full_name: 'Amal  Perera' } }),
    ).toBe('Amal Perera');
  });

  it('returns null when there is no ID result', () => {
    expect(verifiedNameFrom(undefined)).toBeNull();
    expect(verifiedNameFrom({ id_verifications: [] })).toBeNull();
    expect(
      verifiedNameFrom({ id_verifications: [{ full_name: '' }] }),
    ).toBeNull();
  });
});
