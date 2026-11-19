import { safeReferralCode, safeReturnTo } from './telegram-oidc.service';
import { trustProxySetting } from '../../app.setup';

describe('safeReturnTo', () => {
  it.each(['/', '/wallet', '/wallet?tab=send#x', '/a/b'])(
    'keeps %s',
    (path) => {
      expect(safeReturnTo(path)).toBe(path);
    },
  );

  it.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'wallet',
    '/a\nb',
    '',
    undefined,
    ['/x'],
    '/' + 'a'.repeat(600),
  ])('sends %p back to /', (value) => {
    expect(safeReturnTo(value)).toBe('/');
  });
});

describe('safeReferralCode', () => {
  it('keeps the bot format, drops anything else', () => {
    expect(safeReferralCode('PROMO_2024-x')).toBe('PROMO_2024-x');
    expect(safeReferralCode('bad code')).toBeNull();
    expect(safeReferralCode('x'.repeat(65))).toBeNull();
    expect(safeReferralCode(undefined)).toBeNull();
  });
});

describe('trustProxySetting', () => {
  it('is a hop count or a list of proxies; unset trusts none', () => {
    expect(trustProxySetting(undefined)).toBeUndefined();
    expect(trustProxySetting(' ')).toBeUndefined();
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('10.0.0.0/8, 1.2.3.4')).toEqual([
      '10.0.0.0/8',
      '1.2.3.4',
    ]);
  });
});
