import { adminCookieAttributes } from './admin-auth.config';

describe('adminCookieAttributes', () => {
  it('is Lax by default, Secure in production', () => {
    expect(adminCookieAttributes(true, undefined)).toEqual({
      sameSite: 'lax',
      secure: true,
    });
    expect(adminCookieAttributes(false, undefined)).toEqual({
      sameSite: 'lax',
      secure: false,
    });
  });

  it('allows SameSite=None (always Secure) outside production', () => {
    expect(adminCookieAttributes(false, 'none')).toEqual({
      sameSite: 'none',
      secure: true,
    });
  });

  it('never uses None in production, whatever the env says', () => {
    expect(adminCookieAttributes(true, 'none')).toEqual({
      sameSite: 'lax',
      secure: true,
    });
  });
});
