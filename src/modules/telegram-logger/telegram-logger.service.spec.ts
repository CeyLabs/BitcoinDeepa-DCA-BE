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
