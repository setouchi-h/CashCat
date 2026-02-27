import "dotenv/config";

function parseOptional(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function parseNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export const config = {
  scanIntervalSeconds: Number(process.env.SCAN_INTERVAL_SECONDS) || 90,
  stopLossIntervalSeconds: Math.max(5, Math.floor(
    parseNumber(process.env.RUNTIME_AGENTIC_STOP_LOSS_INTERVAL_SECONDS, 10)
  )),
  logLevel: (process.env.LOG_LEVEL ?? "info") as string,
  jupiter: {
    baseUrl: parseOptional(process.env.JUPITER_API_BASE_URL) ?? "https://lite-api.jup.ag",
  },
  walletMcp: {
    enabled: process.env.RUNTIME_WALLET_MCP_ENABLED !== "false",
    command: process.env.RUNTIME_WALLET_MCP_COMMAND ?? "pnpm --filter wallet-mcp start",
    cwd: process.env.RUNTIME_WALLET_MCP_CWD ?? "",
    timeoutSeconds: Number(process.env.RUNTIME_WALLET_MCP_TIMEOUT_SECONDS) || 45,
  },
  killSwitch: process.env.RUNTIME_KILL_SWITCH === "true",
  maxSlippageBps: Number(process.env.RUNTIME_MAX_SLIPPAGE_BPS) || 300,
  stopLossPct: parseNumber(process.env.RUNTIME_AGENTIC_STOP_LOSS_PCT, -0.10),
  takeProfitPct: parseNumber(process.env.RUNTIME_AGENTIC_TAKE_PROFIT_PCT, 0.15),
  maxHoldMinutes: Math.max(5, Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MAX_HOLD_MINUTES, 480))),
  maxOpenPositions: Math.max(1, Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MAX_OPEN_POSITIONS, 5))),
  minTradeSol: Math.max(0.001, parseNumber(process.env.RUNTIME_AGENTIC_MIN_TRADE_SOL, 0.1)),
  maxTradeSol: Math.max(0.001, parseNumber(process.env.RUNTIME_AGENTIC_MAX_TRADE_SOL, 3)),
  minTradeValueUsd: Math.max(0.01, parseNumber(process.env.RUNTIME_AGENTIC_MIN_TRADE_VALUE_USD, 1.0)),
  sellFraction: clamp(parseNumber(process.env.RUNTIME_AGENTIC_SELL_FRACTION, 1), 0.05, 1),
  intentSlippageBps: Math.max(1, Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_INTENT_SLIPPAGE_BPS, 100))),
  minIntentGapSeconds: Math.max(5, Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MIN_INTENT_GAP_SECONDS, 30))),
  maxIntentsPerCycle: Math.max(1, Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MAX_INTENTS_PER_CYCLE, 4))),
  initialCashSol: Math.max(0.1, parseNumber(process.env.RUNTIME_AGENTIC_INITIAL_CASH_SOL, 10)),
  statePath: parseOptional(process.env.RUNTIME_AGENTIC_STATE_PATH) ?? "/tmp/cashcat-runtime/agentic-state/state.json",
  codexTimeoutSeconds: Math.max(30, Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_CODEX_TIMEOUT_SECONDS, 120))),
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 8787,
} as const;
