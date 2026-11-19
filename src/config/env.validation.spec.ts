import { generateKeyPairSync } from 'crypto';
import { validateEnv } from './env.validation';

const pem = (type: 'ed25519' | 'x25519') =>
  generateKeyPairSync(type as 'ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
const ED25519_PEM = pem('ed25519');

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
  BITCOINDEEPA_API_URL: 'https://bitcoindeepa.com',
  BITCOINDEEPA_WALLET_ID: 'wallet',
  BITCOINDEEPA_SEND_PRIVATE_KEY_PEM: ED25519_PEM,
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

  it('requires the CeyPay API in production even with selling off (it prices buys)', () => {
    const prod = { ...base, NODE_ENV: 'production', ...prodSecrets };
    expect(() => validateEnv({ ...prod, CEYPAY_API_SECRET: '' })).toThrow(
      /CEYPAY_API_SECRET/,
    );
  });

  it('requires the CeyPay webhook key and R2 in production only once selling is enabled', () => {
    const prod = { ...base, NODE_ENV: 'production', ...prodSecrets };
    const on = { ...prod, SELL_ENABLED: 'true' };
    expect(() => validateEnv({ ...on, CEYPAY_WEBHOOK_PUBLIC_KEY: '' })).toThrow(
      /CEYPAY_WEBHOOK_PUBLIC_KEY/,
    );
    expect(() => validateEnv({ ...on, R2_BUCKET: '' })).toThrow(/R2_BUCKET/);
    // switched off: deploys without the sell-only configuration
    expect(() =>
      validateEnv({ ...prod, CEYPAY_WEBHOOK_PUBLIC_KEY: '', R2_BUCKET: '' }),
    ).not.toThrow();
  });

  it('requires the BitcoinDeepa bot settings in production (no HMAC fallback)', () => {
    const prod = { ...base, NODE_ENV: 'production', ...prodSecrets };
    expect(() => validateEnv(prod)).not.toThrow();
    for (const name of [
      'BITCOINDEEPA_API_URL',
      'BITCOINDEEPA_WALLET_ID',
      'BITCOINDEEPA_SEND_PRIVATE_KEY_PEM',
    ]) {
      expect(() => validateEnv({ ...prod, [name]: '' })).toThrow(
        new RegExp(name),
      );
    }
  });

  it('rejects a bot key that is not an Ed25519 PEM, in any environment', () => {
    const dev = { ...base, NODE_ENV: 'development' };
    expect(() =>
      validateEnv({ ...dev, BITCOINDEEPA_SEND_PRIVATE_KEY_PEM: 'nope' }),
    ).toThrow(/Ed25519/);
    expect(() =>
      validateEnv({ ...dev, BITCOINDEEPA_SEND_PRIVATE_KEY_PEM: pem('x25519') }),
    ).toThrow(/Ed25519/);
    // one line with literal \n, as some secret stores keep it
    expect(() =>
      validateEnv({
        ...dev,
        BITCOINDEEPA_SEND_PRIVATE_KEY_PEM: ED25519_PEM.replace(/\n/g, '\\n'),
      }),
    ).not.toThrow();
    expect(() => validateEnv(dev)).not.toThrow(); // optional outside production
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

  it('caps how old a fallback exchange rate may be', () => {
    const name = 'EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS';
    expect(validateEnv({ ...base, [name]: '300' })[name]).toBe(300);
    expect(() => validateEnv({ ...base, [name]: '900' })).not.toThrow();
    expect(() => validateEnv({ ...base, [name]: '0' })).not.toThrow(); // off
    // a typo for 300 must not price payments at an 8-hour-old rate
    expect(() => validateEnv({ ...base, [name]: '30000' })).toThrow(
      /EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS/,
    );
    expect(() => validateEnv({ ...base, [name]: '-1' })).toThrow(
      /EXCHANGE_RATE_FALLBACK_MAX_AGE_SECONDS/,
    );
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
