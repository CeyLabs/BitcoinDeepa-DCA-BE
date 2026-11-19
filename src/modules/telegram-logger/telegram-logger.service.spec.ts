import { Logger } from '@nestjs/common';
import { TelegramLoggerService } from './telegram-logger.service';

describe('TelegramLoggerService.logAlert', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.LOG_GROUP_ID = '-100';
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { message_id: 1 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('escapes the text so Telegram accepts the HTML message', async () => {
    await new TelegramLoggerService().logAlert(
      'PayHere <api>',
      'Error: <html>Bad Gateway</html> & retry',
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { text: string; parse_mode: string };
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe(
      '⚠️ <b>ALERT (PayHere &lt;api&gt;)</b>\nError: &lt;html&gt;Bad Gateway&lt;/html&gt; &amp; retry',
    );
  });
});

describe('TelegramLoggerService log group limits', () => {
  const fetchMock = jest.fn();
  const ok = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
    });
  const tooMany = (retryAfter: number) =>
    Promise.resolve({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 429,
          description: `Too Many Requests: retry after ${retryAfter}`,
          parameters: { retry_after: retryAfter },
        }),
    });
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const user = { id: '42', username: 'u' };

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.LOG_GROUP_ID = '-100';
    fetchMock.mockReset().mockImplementation(ok);
    global.fetch = fetchMock as unknown as typeof fetch;
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
    error.mockRestore();
  });

  it("pauses the group for Telegram's retry_after, then resumes and reports what was skipped", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(34));
    await service.logGenericAction('first', user);
    expect(warn).toHaveBeenCalledWith(
      'Telegram rate limited the log group: pausing Telegram logs for 34s',
    );

    await service.logGenericAction('during the pause', user);
    await service.setMessageReaction({ id: 5, text: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing sent while paused

    jest.setSystemTime(1_000_000 + 35_000);
    await service.logGenericAction('after', user);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Telegram log group: 1 message(s) skipped while rate limited', // the reaction isn't a message
    );
  });

  it('keeps routine logs under the per-minute limit, leaving room for alerts', async () => {
    const service = new TelegramLoggerService();
    for (let i = 0; i < 20; i++)
      await service.logGenericAction(`log ${i}`, user);
    expect(fetchMock).toHaveBeenCalledTimes(15);

    await service.logAlert('Settlement', 'needs a human');
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it('queues an alert stopped by a rate limit and sends it when the pause ends', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(10));
    await service.logAlert('Settlement', 'payout stuck');
    expect(error).toHaveBeenCalledWith(
      'ALERT (Settlement) delayed by Telegram rate limits, queued: payout stuck',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(11_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(
      (fetchMock.mock.calls[1] as [string, { body: string }])[1].body,
    ) as { text: string };
    expect(body.text).toContain('payout stuck');
  });

  it("logs an alert Telegram refused for another reason (it's not retried)", async () => {
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
      }),
    );
    await service.logAlert('Settlement', 'payout stuck');
    expect(error).toHaveBeenCalledWith(
      'ALERT (Settlement) not sent to Telegram: payout stuck',
    );
  });

  it('a 429 on a reaction delays a later alert instead of losing it', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(20));
    await service.setMessageReaction({ id: 7, text: 'x' });
    await service.logAlert('Sell', 'needs review');
    expect(fetchMock).toHaveBeenCalledTimes(1); // paused: the alert is queued
    await jest.advanceTimersByTimeAsync(21_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reactions count against the routine cap, so alerts keep their headroom', async () => {
    const service = new TelegramLoggerService();
    // each trackAction is a message + a reaction
    for (let i = 0; i < 10; i++) {
      await service.trackAction(`a${i}`, user, () => Promise.resolve());
    }
    expect(fetchMock).toHaveBeenCalledTimes(15);
    await service.logAlert('Settlement', 'needs a human');
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it('keeps at most 20 queued alerts; the rest are only logged', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(60));
    for (let i = 0; i < 22; i++) await service.logAlert('S', `alert ${i}`);
    const queued = error.mock.calls.filter(([m]) =>
      String(m).includes('queued'),
    );
    expect(queued).toHaveLength(20);
    expect(error).toHaveBeenCalledWith(
      'ALERT (S) not sent to Telegram: alert 21',
    );
  });

  it('a 429 without retry_after uses the Retry-After header, else 30s', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '7' }),
        json: () => Promise.reject(new Error('not JSON')),
      }),
    );
    await service.logGenericAction('a', user);
    expect(warn).toHaveBeenCalledWith(
      'Telegram rate limited the log group: pausing Telegram logs for 7s',
    );

    jest.setSystemTime(1_000_000 + 8_000);
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ ok: false }),
      }),
    );
    await service.logGenericAction('b', user);
    expect(warn).toHaveBeenCalledWith(
      'Telegram rate limited the log group: pausing Telegram logs for 30s',
    );
  });

  it('a later, shorter 429 (a call already in flight) does not shorten the pause', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    let release!: () => void;
    // two calls in flight: the 30s answer lands first, then the 15s one
    fetchMock
      .mockImplementationOnce(() => tooMany(30))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(tooMany(15));
          }),
      );
    const first = service.setMessageReaction({ id: 2, text: 'y' }); // gets the 30s
    const second = service.logGenericAction('first', user); // still in flight
    await first;
    release(); // now the 15s answer lands
    await second;
    const pauses = warn.mock.calls.filter(([m]) =>
      String(m).startsWith('Telegram rate limited'),
    );
    expect(pauses).toHaveLength(1); // only the extension is logged

    jest.setSystemTime(1_000_000 + 20_000); // past 15s, inside 30s
    await service.logGenericAction('still paused', user);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs other Telegram failures as one line', async () => {
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            ok: false,
            description: 'Bad Request: chat not found',
          }),
      }),
    );
    await service.logGenericAction('x', user);
    expect(error).toHaveBeenCalledWith(
      'Telegram sendMessage failed (HTTP 400): Bad Request: chat not found',
    );
  });

  it('skips a reaction or edit without a message quietly', async () => {
    const service = new TelegramLoggerService();
    await service.setMessageReaction(null);
    await service.appendToMessage({ id: null, text: 'x' }, 'more');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the bot token or log group is missing', async () => {
    delete process.env.LOG_GROUP_ID;
    const service = new TelegramLoggerService();
    await service.logGenericAction('a', user);
    await service.logGenericAction('b', user);
    await service.setMessageReaction({ id: 1, text: 'x' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'TELEGRAM_BOT_TOKEN or LOG_GROUP_ID not configured: Telegram ops logs are off',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
