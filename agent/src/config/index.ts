import "dotenv/config";

export interface TokenConfig {
  symbol: string;
  mint: string;
  decimals: number;
}

export type AgenticPlannerMode = "rule" | "llm" | "hybrid";

const DEFAULT_AGENTIC_UNIVERSE: TokenConfig[] = [
  {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  {
    symbol: "JUP",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
  },
  {
    symbol: "JTO",
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    decimals: 9,
  },
];

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseOptional(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function parseNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseTokenUniverse(raw: string | undefined): TokenConfig[] {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_AGENTIC_UNIVERSE;

  const tokens = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [symbolRaw, mintRaw, decimalsRaw] = item.split(":").map((v) => v.trim());
      if (!symbolRaw || !mintRaw || !decimalsRaw) return null;
      const decimals = Number(decimalsRaw);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
      if (mintRaw.length < 32 || mintRaw.length > 44) return null;
      return {
        symbol: symbolRaw.toUpperCase(),
        mint: mintRaw,
        decimals,
      } satisfies TokenConfig;
    })
    .filter((token): token is TokenConfig => Boolean(token));

  return tokens.length > 0 ? tokens : DEFAULT_AGENTIC_UNIVERSE;
}

function parsePlannerMode(raw: string | undefined): AgenticPlannerMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "rule" || value === "llm" || value === "hybrid") {
    return value;
  }
  return "hybrid";
}

export const config = {
  solana: {
    rpcUrl: parseOptional(process.env.HELIUS_API_KEY)
      ? `https://mainnet.helius-rpc.com/?api-key=${parseOptional(process.env.HELIUS_API_KEY)}`
      : "https://api.mainnet-beta.solana.com",
  },
  jupiter: {
    baseUrl:
      parseOptional(process.env.JUPITER_API_BASE_URL) ?? "https://lite-api.jup.ag",
  },
  paperTrade: process.env.PAPER_TRADE !== "false",
  scanIntervalSeconds: Number(process.env.SCAN_INTERVAL_SECONDS) || 20,
  runtime: {
    intentDir: process.env.RUNTIME_INTENT_DIR ?? "/tmp/cashcat-runtime/intents",
    resultDir: process.env.RUNTIME_RESULT_DIR ?? "/tmp/cashcat-runtime/results",
    proposalDir:
      process.env.RUNTIME_PROPOSAL_DIR ?? "/tmp/cashcat-runtime/proposals",
    verdictDir:
      process.env.RUNTIME_VERDICT_DIR ?? "/tmp/cashcat-runtime/verdicts",
    maxIntentsPerCycle: Number(process.env.RUNTIME_MAX_INTENTS_PER_CYCLE) || 10,
    maxProposalsPerCycle:
      Number(process.env.RUNTIME_MAX_PROPOSALS_PER_CYCLE) || 5,
    killSwitch: process.env.RUNTIME_KILL_SWITCH === "true",
    maxAmountLamports:
      Number(process.env.RUNTIME_MAX_AMOUNT_LAMPORTS) || 50_000_000_000,
    maxSlippageBps: Number(process.env.RUNTIME_MAX_SLIPPAGE_BPS) || 300,
    allowedInputMints: parseCsv(process.env.RUNTIME_ALLOWED_INPUT_MINTS),
    allowedOutputMints: parseCsv(process.env.RUNTIME_ALLOWED_OUTPUT_MINTS),
    autoRunCommand: process.env.RUNTIME_AUTO_RUN_COMMAND ?? "",
    autoRunCwd: process.env.RUNTIME_AUTO_RUN_CWD ?? "",
    commandTimeoutSeconds:
      Number(process.env.RUNTIME_COMMAND_TIMEOUT_SECONDS) || 120,
    gate: {
      minPnlDeltaPct: Number(process.env.RUNTIME_GATE_MIN_PNL_DELTA_PCT) || 0.2,
      minSharpeDelta: Number(process.env.RUNTIME_GATE_MIN_SHARPE_DELTA) || 0.05,
      maxDrawdownDeltaPct:
        Number(process.env.RUNTIME_GATE_MAX_DRAWDOWN_DELTA_PCT) || 2,
      minTestPassRate:
        Number(process.env.RUNTIME_GATE_MIN_TEST_PASS_RATE) || 0.95,
    },
    walletMcp: {
      enabled: process.env.RUNTIME_WALLET_MCP_ENABLED !== "false",
      command:
        process.env.RUNTIME_WALLET_MCP_COMMAND ??
        "pnpm --filter wallet-mcp start",
      cwd: process.env.RUNTIME_WALLET_MCP_CWD ?? "",
      timeoutSeconds:
        Number(process.env.RUNTIME_WALLET_MCP_TIMEOUT_SECONDS) || 45,
    },
    agentic: {
      enabled: process.env.RUNTIME_AGENTIC_ENABLED !== "false",
      plannerMode: parsePlannerMode(process.env.RUNTIME_AGENTIC_PLANNER_MODE),
      tokenUniverse: parseTokenUniverse(process.env.RUNTIME_AGENTIC_TOKEN_UNIVERSE),
      historyKeepPoints: Math.max(
        60,
        Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_HISTORY_KEEP_POINTS, 240))
      ),
      minHistoryPointsForSignal: Math.max(
        3,
        Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MIN_HISTORY_POINTS, 6))
      ),
      buyMomentumThreshold: parseNumber(
        process.env.RUNTIME_AGENTIC_BUY_MOMENTUM_THRESHOLD,
        0.004
      ),
      sellMomentumThreshold: parseNumber(
        process.env.RUNTIME_AGENTIC_SELL_MOMENTUM_THRESHOLD,
        -0.003
      ),
      takeProfitPct: parseNumber(process.env.RUNTIME_AGENTIC_TAKE_PROFIT_PCT, 0.15),
      stopLossPct: parseNumber(process.env.RUNTIME_AGENTIC_STOP_LOSS_PCT, -0.10),
      maxHoldMinutes: Math.max(
        5,
        Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MAX_HOLD_MINUTES, 480))
      ),
      tradeAllocationPct: clamp(
        parseNumber(process.env.RUNTIME_AGENTIC_TRADE_ALLOCATION_PCT, 0.15),
        0.01,
        1
      ),
      minTradeSol: Math.max(
        0.001,
        parseNumber(process.env.RUNTIME_AGENTIC_MIN_TRADE_SOL, 0.1)
      ),
      maxTradeSol: Math.max(
        0.001,
        parseNumber(process.env.RUNTIME_AGENTIC_MAX_TRADE_SOL, 3)
      ),
      maxOpenPositions: Math.max(
        1,
        Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MAX_OPEN_POSITIONS, 5))
      ),
      sellFraction: clamp(
        parseNumber(process.env.RUNTIME_AGENTIC_SELL_FRACTION, 1),
        0.05,
        1
      ),
      intentSlippageBps: Math.max(
        1,
        Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_INTENT_SLIPPAGE_BPS, 100))
      ),
      minIntentGapSeconds: Math.max(
        5,
        Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MIN_INTENT_GAP_SECONDS, 30))
      ),
      maxIntentsPerCycle: Math.max(
        1,
        Math.floor(parseNumber(process.env.RUNTIME_AGENTIC_MAX_INTENTS_PER_CYCLE, 4))
      ),
      initialCashSol: Math.max(
        0.1,
        parseNumber(process.env.RUNTIME_AGENTIC_INITIAL_CASH_SOL, 10)
      ),
      statePath:
        parseOptional(process.env.RUNTIME_AGENTIC_STATE_PATH) ??
        "/tmp/cashcat-runtime/agentic-state/state.json",
      sourceTag: parseOptional(process.env.RUNTIME_AGENTIC_SOURCE_TAG) ?? "agentic-core",
      llm: {
        enabled: process.env.RUNTIME_AGENTIC_LLM_ENABLED !== "false",
        apiKey:
          parseOptional(process.env.RUNTIME_AGENTIC_LLM_API_KEY) ??
          parseOptional(process.env.OPENAI_API_KEY) ??
          "",
        baseUrl:
          parseOptional(process.env.RUNTIME_AGENTIC_LLM_BASE_URL) ??
          "https://api.openai.com/v1",
        model:
          parseOptional(process.env.RUNTIME_AGENTIC_LLM_MODEL) ?? "gpt-5-mini",
        temperature: clamp(
          parseNumber(process.env.RUNTIME_AGENTIC_LLM_TEMPERATURE, 0.2),
          0,
          2
        ),
        maxOutputTokens: Math.max(
          256,
          parseInteger(process.env.RUNTIME_AGENTIC_LLM_MAX_OUTPUT_TOKENS, 1000)
        ),
        timeoutSeconds: Math.max(
          5,
          parseInteger(process.env.RUNTIME_AGENTIC_LLM_TIMEOUT_SECONDS, 25)
        ),
      },
    },
  },
} as const;
