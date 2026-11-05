import { config } from '../config';

const SENSITIVE = /pass|token|secret|authorization|cookie|phone|email|lat|lng|location|document|address|code|otp|dni|birth/i;

/** Redacta recursivamente claves sensibles (criterio 26: sin ubicación, documentos ni tokens en logs). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'correlationId' || k === 'stack' || k === 'constraint' || k === 'err') out[k] = v;
    else out[k] = SENSITIVE.test(k) ? '[REDACTADO]' : redact(v, depth + 1);
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export const logSink: { lines: string[]; capture: boolean } = { lines: [], capture: false };

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[config().LOG_LEVEL]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(meta ?? {}) as object) });
  if (logSink.capture) logSink.lines.push(line);
  if (config().APP_ENV === 'test' && !process.env.TEST_LOGS) return;
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => write('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => write('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => write('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => write('error', m, meta),
};
