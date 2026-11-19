import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import {
  apiName,
  bodyForLog,
  installExternalApiLogging,
  levelFor,
  redactUrl,
  redactValue,
  useJsonLogs,
} from './dev-logging';
import { DatabaseSystemLogger } from '../modules/knex/database-system-logger.service';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('redaction', () => {
  it("hides Telegram's bot token and secret query parameters", () => {
    expect(
      redactUrl('https://api.telegram.org/bot123:ABC-def/sendMessage'),
    ).toBe('https://api.telegram.org/bot***/sendMessage');
    const presigned = redactUrl(
      'https://b.r2.cloudflarestorage.com/f.pdf?X-Amz-Signature=abc&X-Amz-Credential=k&x-id=PutObject',
    );
    expect(presigned).toContain('X-Amz-Signature=***');
    expect(presigned).toContain('X-Amz-Credential=***');
    expect(presigned).toContain('x-id=PutObject');
  });

  it('hides secret-looking keys at any depth, keeps the rest', () => {
    expect(
      redactValue({
        access_token: 'a',
        amount: 100,
        nested: { merchant_secret: 's', memo: 'm', items: [{ id_token: 'x' }] },
      }),
    ).toEqual({
      access_token: '***',
      amount: 100,
      nested: {
        merchant_secret: '***',
        memo: 'm',
        items: [{ id_token: '***' }],
      },
    });
  });

  it('parses JSON and form bodies before redacting; cuts long text', () => {
    expect(bodyForLog('{"password":"p","to":"42"}')).toEqual({
      password: '***',
      to: '42',
    });
    expect(bodyForLog('grant_type=client_credentials&client_secret=s')).toEqual(
      {
        grant_type: 'client_credentials',
        client_secret: '***',
      },
    );
    expect(String(bodyForLog('x'.repeat(5000)))).toMatch(/… \(5000 chars\)$/);
    expect(bodyForLog(new Uint8Array([1, 2]))).toBe('[binary]');
    expect(bodyForLog('')).toBeUndefined();
  });
});

describe('levels and names', () => {
  it('2xx/3xx INFO, 4xx WARN, 5xx or no response ERROR', () => {
    expect(levelFor(200)).toBe('log');
    expect(levelFor(302)).toBe('log');
    expect(levelFor(404)).toBe('warn');
    expect(levelFor(503)).toBe('error');
    expect(levelFor(undefined)).toBe('error');
  });

  it('names the APIs we call', () => {
    expect(apiName('https://sandbox-api.ceypay.io/v1/x')).toBe('CeyPay');
    expect(apiName('https://bitcoindeepa.com/api/v1/send')).toBe(
      'BitcoinDeepa bot',
    );
    expect(apiName('https://example.org/x')).toBe('example.org');
  });

  it('uses JSON lines only in development on Railway (or LOG_FORMAT=json)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.LOG_FORMAT;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    delete process.env.RAILWAY_ENVIRONMENT;
    expect(useJsonLogs()).toBe(false); // local
    process.env.RAILWAY_ENVIRONMENT_NAME = 'development';
    expect(useJsonLogs()).toBe(true);
    process.env.LOG_FORMAT = 'pretty';
    expect(useJsonLogs()).toBe(false);
    process.env.NODE_ENV = 'production';
    process.env.LOG_FORMAT = 'json';
    expect(useJsonLogs()).toBe(false); // never outside development
  });
});

describe('installExternalApiLogging', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const fetchMock = jest.fn();
  const adapterReturning =
    (status: number, data: unknown) => (config: InternalAxiosRequestConfig) =>
      status < 400
        ? Promise.resolve({ data, status, statusText: '', headers: {}, config })
        : Promise.reject(
            new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, {
              data,
              status,
              statusText: '',
              headers: {},
              config,
            }),
          );
  const lastLine = (level: 'log' | 'warn' | 'error') =>
    String(logger[level].mock.calls.at(-1)?.[0]);

  beforeAll(() => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_FORMAT = 'pretty';
    global.fetch = fetchMock as unknown as typeof fetch;
    installExternalApiLogging(logger);
    installExternalApiLogging(logger); // a second install is a no-op
  });
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_FORMAT = 'pretty';
    jest.clearAllMocks();
  });

  it('logs an axios call with its redacted request and response as INFO', async () => {
    await axios.post(
      'https://sandbox-api.ceypay.io/v1/aggregator/quote',
      { amount_usdt: 1, api_key: 'k' },
      { adapter: adapterReturning(200, { rateUsdtLkr: 332, token: 't' }) },
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][1]).toBe('ExternalAPI');
    const line = lastLine('log');
    expect(line).toMatch(
      /^CeyPay POST \/v1\/aggregator\/quote → 200 \(\d+ms\)/,
    );
    expect(line).toContain('"amount_usdt":1');
    expect(line).toContain('"rateUsdtLkr":332');
    expect(line).not.toContain('"k"');
    expect(line).not.toContain('"t"');
  });

  it('logs a 4xx as WARN and a 5xx as ERROR, and still rejects', async () => {
    await expect(
      axios.get('https://bitcoindeepa.com/api/v1/send/status/x', {
        adapter: adapterReturning(404, { error: 'not found' }),
      }),
    ).rejects.toThrow();
    expect(lastLine('warn')).toMatch(/^BitcoinDeepa bot GET .* → 404/);

    await expect(
      axios.get('https://fx.ceyloncash.com/currency/BTC', {
        adapter: adapterReturning(503, 'down'),
      }),
    ).rejects.toThrow();
    expect(lastLine('error')).toMatch(/^Ceylon Cash GET \/currency\/BTC → 503/);
    // error(message, stack, context): context third, no stray stack
    expect(logger.error.mock.calls.at(-1)?.slice(1)).toEqual([
      undefined,
      'ExternalAPI',
    ]);
  });

  it('logs a call with no response (timeout) as ERROR', async () => {
    await expect(
      axios.get('https://pro-api.coinmarketcap.com/v1/x', {
        adapter: (config) =>
          Promise.reject(
            new AxiosError(
              'timeout of 10000ms exceeded',
              'ECONNABORTED',
              config,
            ),
          ),
      }),
    ).rejects.toThrow();
    expect(lastLine('error')).toMatch(
      /^CoinMarketCap GET \/v1\/x → ECONNABORTED: timeout of 10000ms exceeded/,
    );
  });

  it('logs fetch calls without the bot token and leaves the body readable', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      }),
    );
    const response = await fetch(
      'https://api.telegram.org/bot123:SECRET/sendMessage',
      { method: 'POST', body: JSON.stringify({ chat_id: '-100', text: 'hi' }) },
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: { message_id: 1 },
    });
    const line = lastLine('log');
    expect(line).toMatch(/^Telegram POST \/bot\*\*\*\/sendMessage → 200/);
    expect(line).not.toContain('SECRET');
    expect(line).toContain('"text":"hi"');
  });

  it('logs a fetch that throws as ERROR and rethrows', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      fetch('https://verification.didit.me/v3/session/'),
    ).rejects.toThrow('ENOTFOUND');
    expect(lastLine('error')).toMatch(/^Didit GET \/v3\/session\/ → ENOTFOUND/);
  });

  it('logs nothing outside development', () => {
    process.env.NODE_ENV = 'production';
    // installed at startup only in development; simulate a production process
    // by checking that a fresh install is refused
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('./dev-logging') as typeof import('./dev-logging');
      const other = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      fresh.installExternalApiLogging(other);
      expect(other.log).not.toHaveBeenCalled();
    });
    expect(
      (axios.interceptors.request as unknown as { handlers: unknown[] })
        .handlers.length,
    ).toBe(1); // only the development install from beforeAll
  });
});

describe('DatabaseSystemLogger JSON lines (development on Railway)', () => {
  let write: jest.SpyInstance;
  const lines = () =>
    write.mock.calls.map(
      ([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>,
    );

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_FORMAT = 'json';
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => write.mockRestore());

  it("writes Railway's level names, all on stdout", () => {
    const logger = new DatabaseSystemLogger();
    logger.log('hello', 'Ctx');
    logger.warn('careful', 'Ctx');
    logger.error('broke', 'stack here', 'Ctx');
    logger.debug('details', 'Ctx');
    expect(lines().map((l) => [l.level, l.message, l.context])).toEqual([
      ['info', 'hello', 'Ctx'],
      ['warn', 'careful', 'Ctx'],
      ['error', 'broke', 'Ctx'],
      ['debug', 'details', 'Ctx'],
    ]);
    expect(lines()[2].stack).toBe('stack here');
  });

  it('puts an API call’s fields at the top level, and survives circular objects', () => {
    const logger = new DatabaseSystemLogger();
    logger.log(
      { msg: 'CeyPay GET /x → 200 (5ms)', api: 'CeyPay', status: 200 },
      'ExternalAPI',
    );
    expect(lines()[0]).toMatchObject({
      level: 'info',
      message: 'CeyPay GET /x → 200 (5ms)',
      api: 'CeyPay',
      status: 200,
      context: 'ExternalAPI',
    });

    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    logger.log(circular, 'Ctx');
    expect(lines()[1].message).toEqual({ a: 1, self: '[Circular]' });
  });
});
