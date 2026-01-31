function formatTimestamp(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export type Logger = {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
};

export function createLogger(prefix?: string): Logger {
  const p = prefix || "[codex-http] ";

  function log(line: string) {
    process.stdout.write(`${p}${formatTimestamp(new Date())} ${line}\n`);
  }

  return {
    info: log,
    warn: log,
    error: log,
  };
}

