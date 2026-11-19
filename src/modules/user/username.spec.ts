import {
  maskDisplayName,
  normalizeUsername,
  RESERVED_USERNAMES,
  usernameUnavailableReason,
} from './username';

describe('usernames', () => {
  it('normalizes what people type', () => {
    expect(normalizeUsername(' @Kasun_77 ')).toBe('kasun_77');
    expect(normalizeUsername('@@Bob')).toBe('bob');
  });

  it.each([
    ['ok_name1', null],
    ['ab', 'Use 3-20 letters, digits or underscores, starting with a letter'],
    ['1abc', 'Use 3-20 letters, digits or underscores, starting with a letter'],
    [
      'a'.repeat(21),
      'Use 3-20 letters, digits or underscores, starting with a letter',
    ],
    [
      'has-dash',
      'Use 3-20 letters, digits or underscores, starting with a letter',
    ],
    ['bitcoindeepa', 'This username is reserved'],
    ['admin', 'This username is reserved'],
  ])('%s → %s', (name, reason) => {
    expect(usernameUnavailableReason(name, false)).toBe(reason);
  });

  it('says taken last', () => {
    expect(usernameUnavailableReason('nimal', true)).toBe(
      'This username is taken',
    );
  });

  it('reserves our brands', () => {
    for (const name of ['bitcoindeepa', 'deepa', 'ceypay', 'ceylabs']) {
      expect(RESERVED_USERNAMES.has(name)).toBe(true);
    }
  });

  it('masks names to first + initial, skipping leading initials', () => {
    expect(maskDisplayName('Nimal Silva Fernando')).toBe('Nimal S.');
    expect(maskDisplayName('K.A.D. Perera Silva')).toBe('Perera S.');
    expect(maskDisplayName('Kasun')).toBe('Kasun');
    expect(maskDisplayName('  ')).toBeNull();
  });
});
