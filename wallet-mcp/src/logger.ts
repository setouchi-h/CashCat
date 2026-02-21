type Level = "INFO" | "WARN" | "ERROR";

function formatMessage(scope: string, level: Level, message: string): string {
  return `[${new Date().toISOString()}] [wallet-mcp:${scope}] ${level} ${message}\n`;
}

export function createLogger(scope: string) {
  return {
    info(message: string): void {
      process.stderr.write(formatMessage(scope, "INFO", message));
    },
    warn(message: string): void {
      process.stderr.write(formatMessage(scope, "WARN", message));
    },
    error(message: string, error?: unknown): void {
      let suffix = "";
      if (error instanceof Error) {
        suffix = ` | ${error.message}`;
      } else if (typeof error !== "undefined") {
        suffix = ` | ${String(error)}`;
      }
      process.stderr.write(formatMessage(scope, "ERROR", `${message}${suffix}`));
    },
  };
}
