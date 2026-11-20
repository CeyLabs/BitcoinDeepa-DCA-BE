import type { LoggerService } from '@nestjs/common';
import axios, {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';

/**
 * Development-only logging (NODE_ENV=development): every external API call
 * with its request and response, and JSON log lines on Railway so its log
 * view shows INFO / WARN / ERROR badges and filterable fields. Production
 * logging is untouched.
 */
export const isDevLogging = (): boolean =>
  process.env.NODE_ENV === 'development';

/**
 * JSON lines on Railway (where they're parsed into badges and fields),
 * readable text locally. LOG_FORMAT=json|pretty overrides.
 */
export const useJsonLogs = (): boolean => {
  if (!isDevLogging()) return false;
  const format = process.env.LOG_FORMAT;
  if (format === 'json') return true;
  if (format === 'pretty') return false;
  return !!(
    process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT
  );
};

/** Logger context of the external API lines (kept out of the DB log table) */
export const EXTERNAL_API_CONTEXT = 'ExternalAPI';

const MAX_BODY_CHARS = 4000;
const REDACTED = '***';

/** Keys whose values are secrets (case-insensitive, matched anywhere in the key) */
const SECRET_KEY =
  /token|secret|password|passwd|signature|apikey|api_key|authorization|hash|pem|private|init_?data|credential|cookie|otp/i;
/** Query parameters that carry secrets (API keys, presigned URL signatures) */
const SECRET_QUERY =
  /key|token|secret|signature|sig|credential|auth|password|hash/i;

/** Readable names for the hosts we call */
const API_NAMES: Array<[RegExp, string]> = [
  [/ceypay/i, 'CeyPay'],
  [/bitcoindeepa/i, 'BitcoinDeepa bot'],
  [/payhere/i, 'PayHere'],
  [/ceyloncash/i, 'Ceylon Cash'],
  [/coinmarketcap/i, 'CoinMarketCap'],
  [/api\.telegram\.org/i, 'Telegram'],
  [/didit/i, 'Didit'],
  [/r2\.cloudflarestorage/i, 'R2'],
];

export function apiName(url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* not absolute: keep as is */
  }
  return API_NAMES.find(([pattern]) => pattern.test(host))?.[1] ?? host;
}

/**
 * The URL without secrets: Telegram's bot token in the path, and secret
 * query parameters.
 */
export function redactUrl(url: string): string {
  const withoutBotToken = url.replace(/\/bot\d+:[^/]+/g, `/bot${REDACTED}`);
  try {
    const parsed = new URL(withoutBotToken);
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY.test(name)) parsed.searchParams.set(name, REDACTED);
    }
    return parsed.toString();
  } catch {
    return withoutBotToken;
  }
}

/** A copy of `value` with every secret-looking key's value replaced. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/**
 * A body as something safe and short to log: JSON is parsed, redacted and
 * re-serialized; form bodies are redacted per field; anything else is cut.
 */
export function bodyForLog(body: unknown): unknown {
  if (body === undefined || body === null || body === '') return undefined;
  let value: unknown = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      if (/^[\w.%-]+=/.test(body) && body.includes('=')) {
        const form = new URLSearchParams(body);
        value = Object.fromEntries(
          [...form.entries()].map(([k, v]) => [
            k,
            SECRET_KEY.test(k) ? REDACTED : v,
          ]),
        );
      } else {
        return truncate(body);
      }
    }
  } else if (
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== 'undefined' && body instanceof Blob)
  ) {
    return '[binary]';
  }
  const redacted = redactValue(value);
  const text = JSON.stringify(redacted);
  return text && text.length > MAX_BODY_CHARS ? truncate(text) : redacted;
}

const truncate = (text: string): string =>
  text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}… (${text.length} chars)`
    : text;

/** One external call, as logged */
export interface ExternalApiCall {
  api: string;
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  request?: unknown;
  response?: unknown;
  error?: string;
}

type LogLevelName = 'log' | 'warn' | 'error';

/** 2xx/3xx INFO, 4xx WARN, 5xx or no response ERROR */
export const levelFor = (status?: number): LogLevelName =>
  status === undefined || status >= 500
    ? 'error'
    : status >= 400
      ? 'warn'
      : 'log';

/**
 * Logger.error's signature is (message, stack, context): the context has to
 * be the third argument there, or it's printed as a stack trace.
 */
function write(
  logger: LoggerService,
  level: LogLevelName,
  message: unknown,
): void {
  if (level === 'error') {
    logger.error(message, undefined, EXTERNAL_API_CONTEXT);
  } else {
    logger[level](message, EXTERNAL_API_CONTEXT);
  }
}

export function logExternalCall(
  logger: LoggerService,
  call: ExternalApiCall,
): void {
  const outcome =
    call.status !== undefined ? String(call.status) : (call.error ?? 'failed');
  let path = call.url;
  try {
    path = new URL(call.url).pathname;
  } catch {
    /* keep */
  }
  const summary = `${call.api} ${call.method} ${path} → ${outcome} (${call.durationMs}ms)`;
  const level = levelFor(call.status);

  if (useJsonLogs()) {
    // Railway turns these fields into filters: @api:CeyPay @status:500
    write(logger, level, { msg: summary, ...call });
    return;
  }
  const details = [
    `  url: ${call.url}`,
    call.request !== undefined && `  request: ${JSON.stringify(call.request)}`,
    call.response !== undefined &&
      `  response: ${JSON.stringify(call.response)}`,
    call.error && `  error: ${call.error}`,
  ]
    .filter(Boolean)
    .join('\n');
  write(logger, level, `${summary}\n${details}`);
}

const START = Symbol('externalApiStart');
type TimedConfig = InternalAxiosRequestConfig & { [START]?: number };

let installed = false;

/**
 * Log every call made through the default axios instance (CeyPay, the
 * BitcoinDeepa bot, PayHere, Ceylon Cash, CoinMarketCap) and global fetch
 * (Telegram, Didit). Request headers are never logged; bodies and URLs are
 * redacted. Only in development; safe to call more than once.
 */
export function installExternalApiLogging(logger: LoggerService): void {
  if (!isDevLogging() || installed) return;
  installed = true;

  axios.interceptors.request.use((config: TimedConfig) => {
    config[START] = Date.now();
    return config;
  });

  const fromAxios = (
    config: TimedConfig | undefined,
    response: AxiosResponse | undefined,
    error?: string,
  ): ExternalApiCall => {
    const url = redactUrl(axios.getUri(config ?? {}));
    return {
      api: apiName(url),
      method: (config?.method ?? 'get').toUpperCase(),
      url,
      status: response?.status,
      durationMs: Date.now() - (config?.[START] ?? Date.now()),
      request: bodyForLog(config?.data),
      response: bodyForLog(response?.data),
      ...(error && { error }),
    };
  };

  axios.interceptors.response.use(
    (response: AxiosResponse) => {
      logExternalCall(
        logger,
        fromAxios(response.config as TimedConfig, response),
      );
      return response;
    },
    (error: unknown) => {
      if (error instanceof AxiosError) {
        logExternalCall(
          logger,
          fromAxios(
            error.config as TimedConfig | undefined,
            error.response,
            error.response
              ? undefined
              : `${error.code ?? 'ERROR'}: ${error.message}`,
          ),
        );
      }
      // Pass axios's rejection through untouched: callers inspect it
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    },
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const started = Date.now();
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = redactUrl(rawUrl);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const base = {
      api: apiName(url),
      method,
      url,
      request: bodyForLog(init?.body),
    };
    try {
      const response = await originalFetch(input, init);
      // Read a copy: the caller still gets the untouched body
      const text = await response
        .clone()
        .text()
        .catch(() => undefined);
      logExternalCall(logger, {
        ...base,
        status: response.status,
        durationMs: Date.now() - started,
        response: bodyForLog(text),
      });
      return response;
    } catch (error) {
      logExternalCall(logger, {
        ...base,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
