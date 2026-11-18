import { createHmac } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

const BOT_TOKEN = '123456:test-bot-token';

/** Build initData the way Telegram signs it. */
function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN) {
  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 100000001, first_name: 'Test' });

describe('AuthService.verifyTelegramInitData', () => {
  const service = new AuthService(new JwtService({ secret: 'test' }));

  it('accepts correctly signed, fresh initData', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds()),
      user,
      signature: 'ed25519-sig-is-part-of-the-hash-check',
    });
    expect(service.verifyTelegramInitData(initData, BOT_TOKEN)).toBe(true);
  });

  it('rejects a tampered field', () => {
    const initData = signInitData({ auth_date: String(nowSeconds()), user });
    const tampered = initData.replace('100000001', '999999999');
    expect(service.verifyTelegramInitData(tampered, BOT_TOKEN)).toBe(false);
  });

  it('rejects data signed with another bot token', () => {
    const initData = signInitData(
      { auth_date: String(nowSeconds()), user },
      '999:other-bot',
    );
    expect(service.verifyTelegramInitData(initData, BOT_TOKEN)).toBe(false);
  });

  it('rejects initData older than 1 hour', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds() - 60 * 60 - 5),
      user,
    });
    expect(service.verifyTelegramInitData(initData, BOT_TOKEN)).toBe(false);
  });

  it('rejects auth_date in the future (beyond clock skew)', () => {
    const initData = signInitData({
      auth_date: String(nowSeconds() + 300),
      user,
    });
    expect(service.verifyTelegramInitData(initData, BOT_TOKEN)).toBe(false);
  });

  it('rejects missing hash or auth_date', () => {
    expect(service.verifyTelegramInitData(`user=${user}`, BOT_TOKEN)).toBe(
      false,
    );
  });
});
