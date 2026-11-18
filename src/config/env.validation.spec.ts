import { validateEnv } from './env.validation';

const base = { JWT_SECRET: 'secret' };
const prodSecrets = {
  TELEGRAM_BOT_TOKEN: 't',
  PAYHERE_MERCHANT_ID: 'm',
  PAYHERE_MERCHANT_SECRET: 's',
  PAYHERE_APP_ID: 'a',
  PAYHERE_APP_SECRET: 'as',
  DIDIT_WEBHOOK_SECRET: 'd',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BASE_URL: 'https://api.example.com',
  ADMIN_APP_URL: 'https://admin.example.com',
  CEYPAY_API_URL: 'https://api.ceypay.io',
  CEYPAY_API_KEY_ID: 'ak_live_x',
  CEYPAY_API_SECRET: 'sk_live_x',
  CEYPAY_WEBHOOK_PUBLIC_KEY: 'pk',
  R2_ACCOUNT_ID: 'r2',
  R2_ACCESS_KEY_ID: 'r2k',
  R2_SECRET_ACCESS_KEY: 'r2s',
  R2_BUCKET: 'statements',
};

describe('validateEnv', () => {
  it('accepts a minimal development config', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('requires JWT_SECRET', () => {
    expect(() => validateEnv({})).toThrow(/JWT_SECRET/);
  });

  it('requires provider secrets in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /DIDIT_WEBHOOK_SECRET/,
    );
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', ...prodSecrets }),
    ).not.toThrow();
    // settlement can't confirm payments with PayHere without the OAuth app
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        ...prodSecrets,
        PAYHERE_APP_SECRET: '',
      }),
    ).toThrow(/PAYHERE_APP_SECRET/);
  });

  it('requires CeyPay and R2 in production only once selling is enabled', () => {
    const prod = { ...base, NODE_ENV: 'production', ...prodSecrets };
    const on = { ...prod, SELL_ENABLED: 'true' };
    expect(() => validateEnv({ ...on, CEYPAY_API_SECRET: '' })).toThrow(
      /CEYPAY_API_SECRET/,
    );
    expect(() => validateEnv({ ...on, R2_BUCKET: '' })).toThrow(/R2_BUCKET/);
    // switched off: the buy flow deploys without any sell configuration
    expect(() =>
      validateEnv({ ...prod, CEYPAY_API_SECRET: '', R2_BUCKET: '' }),
    ).not.toThrow();
  });

  it('allows the bot collect mock only with the CeyPay sandbox', () => {
    expect(() =>
      validateEnv({
        ...base,
        BITCOINDEEPA_COLLECT_MOCK: 'true',
        CEYPAY_API_URL: 'https://api.ceypay.io',
      }),
    ).toThrow(/BITCOINDEEPA_COLLECT_MOCK/);
    expect(() =>
      validateEnv({
        ...base,
        BITCOINDEEPA_COLLECT_MOCK: 'true',
        CEYPAY_API_URL: 'https://sandbox-api.ceypay.io',
      }),
    ).not.toThrow();
  });

  it('requires a strong admin auth secret in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        ...prodSecrets,
        BETTER_AUTH_SECRET: 'too-short',
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('requires BASE_URL in production; BETTER_AUTH_URL is optional', () => {
    const prod = { ...base, NODE_ENV: 'production', ...prodSecrets };
    expect(() => validateEnv({ ...prod, BASE_URL: '' })).toThrow(/BASE_URL/);
    expect(() =>
      validateEnv({ ...prod, BETTER_AUTH_URL: 'not a url' }),
    ).toThrow(/BETTER_AUTH_URL/);
  });

  it('allows a SameSite=None admin cookie outside production only', () => {
    expect(() =>
      validateEnv({ ...base, ADMIN_COOKIE_SAME_SITE: 'none' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        ...prodSecrets,
        ADMIN_COOKIE_SAME_SITE: 'none',
      }),
    ).toThrow(/ADMIN_COOKIE_SAME_SITE/);
    expect(() =>
      validateEnv({ ...base, ADMIN_COOKIE_SAME_SITE: 'strict' }),
    ).toThrow(/ADMIN_COOKIE_SAME_SITE/);
  });

  it('converts numeric strings and rejects out-of-range values', () => {
    expect(validateEnv({ ...base, PORT: '3000' }).PORT).toBe(3000);
    expect(() =>
      validateEnv({ ...base, PAYHERE_FEE_BASIS_POINTS: '20000' }),
    ).toThrow(/PAYHERE_FEE_BASIS_POINTS/);
  });

  it("accepts the knexfile's localhost environment", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'localhost' })).not.toThrow();
  });

  it('rejects unknown enum values', () => {
    expect(() => validateEnv({ ...base, PAYHERE_ENV: 'prod' })).toThrow(
      /PAYHERE_ENV/,
    );
    expect(() => validateEnv({ ...base, ENABLE_AUTH: 'yes' })).toThrow(
      /ENABLE_AUTH/,
    );
  });
});
