type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

function formatTimestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[minLevel];
}

function formatMessage(level: LogLevel, tag: string, msg: string): string {
  return `${formatTimestamp()} [${level.toUpperCase()}] [${tag}] ${msg}`;
}

export function createLogger(tag: string) {
  return {
    debug(msg: string, data?: unknown) {
      if (!shouldLog("debug")) return;
      console.debug(formatMessage("debug", tag, msg), data ?? "");
    },
    info(msg: string, data?: unknown) {
      if (!shouldLog("info")) return;
      console.info(formatMessage("info", tag, msg), data ?? "");
    },
    warn(msg: string, data?: unknown) {
      if (!shouldLog("warn")) return;
      console.warn(formatMessage("warn", tag, msg), data ?? "");
    },
    error(msg: string, data?: unknown) {
      if (!shouldLog("error")) return;
      console.error(formatMessage("error", tag, msg), data ?? "");
    },
  };
}
