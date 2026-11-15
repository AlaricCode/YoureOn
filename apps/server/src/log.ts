// Minimal structured logger (one JSON line per entry). Never pass tokens, signatures, seeds
// or face data as fields (DATA-MODEL §10).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = Record<LogLevel, (msg: string, fields?: Record<string, unknown>) => void>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(min: LogLevel | 'silent' = 'info'): Logger {
  const at = (level: LogLevel) => (msg: string, fields?: Record<string, unknown>) => {
    if (min === 'silent' || ORDER[level] < ORDER[min]) return;
    const line = JSON.stringify(
      { t: new Date().toISOString(), level, msg, ...fields },
      (_k, v: unknown) =>
        typeof v === 'bigint'
          ? v.toString()
          : v instanceof Error
            ? { name: v.name, message: v.message }
            : v,
    );
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = createLogger('silent');
