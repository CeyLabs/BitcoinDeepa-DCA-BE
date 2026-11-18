import { matchAccountName, tokenizeName } from './name-match.util';

describe('matchAccountName', () => {
  it('matches the same full name', () => {
    expect(matchAccountName('Amal Perera', 'AMAL PERERA')).toEqual({
      isMatch: true,
      score: 1,
    });
  });

  it('matches initials + surname against the full KYC name', () => {
    expect(
      matchAccountName('K.A.D. PERERA', 'Kankanamge Amal Dilshan Perera'),
    ).toEqual({ isMatch: true, score: 1 });
  });

  it('ignores titles', () => {
    expect(matchAccountName('Mr. A Perera', 'Amal Perera').isMatch).toBe(true);
  });

  it('does not match a different person', () => {
    const result = matchAccountName('Nimal Silva', 'Amal Perera');
    expect(result.isMatch).toBe(false);
    expect(result.score).toBe(0);
  });

  it('needs at least one full word, not only initials', () => {
    expect(matchAccountName('A P', 'Amal Perera').isMatch).toBe(false);
  });

  it('gives a partial score when some tokens are unexplained', () => {
    const result = matchAccountName('Amal Perera Silva', 'Amal Perera');
    expect(result.isMatch).toBe(false);
    expect(result.score).toBeCloseTo(0.6667, 4);
  });

  it('handles empty names', () => {
    expect(matchAccountName('', 'Amal')).toEqual({ isMatch: false, score: 0 });
  });

  it('tokenizes punctuation and initials', () => {
    expect(tokenizeName('Dr. K.A. de-Silva')).toEqual([
      'K',
      'A',
      'DE',
      'SILVA',
    ]);
  });
});
