import { validateEnv } from './env.validation';

const base = { JWT_SECRET: 'secret' };
const prodSecrets = {
  TELEGRAM_BOT_TOKEN: 't',
  PAYHERE_MERCHANT_ID: 'm',
  PAYHERE_MERCHANT_SECRET: 's',
  PAYHERE_APP_ID: 'a',
  PAYHERE_APP_SECRET: 'as',
  DIDIT_WEBHOOK_SECRET: 'd',
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
