import "dotenv/config";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface TokenConfig {
  symbol: string;
  mint: string;
  decimals: number;
}

const DEFAULT_UNIVERSE: TokenConfig[] = [
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
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwzgq2QHMYy",
    decimals: 9,
  },
];

function parseNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseTokenUniverse(raw: string | undefined): TokenConfig[] {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_UNIVERSE;

  const items = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [symbolRaw, mintRaw, decimalsRaw] = part.split(":").map((v) => v.trim());
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

  return items.length > 0 ? items : DEFAULT_UNIVERSE;
}

export const config = {
  runtime: {
    intentDir: process.env.RUNTIME_INTENT_DIR ?? "/tmp/cashcat-runtime/intents",
    resultDir: process.env.RUNTIME_RESULT_DIR ?? "/tmp/cashcat-runtime/results",
    proposalDir:
      process.env.RUNTIME_PROPOSAL_DIR ?? "/tmp/cashcat-runtime/proposals",
    verdictDir:
      process.env.RUNTIME_VERDICT_DIR ?? "/tmp/cashcat-runtime/verdicts",
  },
  market: {
    jupiterApiKey: process.env.JUPITER_API_KEY ?? "",
    jupiterBaseUrl:
      process.env.JUPITER_API_BASE_URL ??
      (process.env.JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag"),
    tokenUniverse: parseTokenUniverse(process.env.LAB_TOKEN_UNIVERSE),
    historyKeepPoints: Math.max(
      60,
      Math.floor(parseNumber(process.env.LAB_HISTORY_KEEP_POINTS, 240))
    ),
    minHistoryPointsForSignal: Math.max(
      3,
      Math.floor(parseNumber(process.env.LAB_MIN_HISTORY_POINTS_FOR_SIGNAL, 6))
    ),
  },
  loop: {
    intervalSeconds: Math.max(
      5,
      Math.floor(parseNumber(process.env.LAB_LOOP_INTERVAL_SECONDS, 20))
    ),
    runOnce: process.env.LAB_RUN_ONCE === "true",
    minIntentGapSeconds: Math.max(
      5,
      Math.floor(parseNumber(process.env.LAB_MIN_INTENT_GAP_SECONDS, 60))
    ),
    maxIntentsPerCycle: Math.max(
      1,
      Math.floor(parseNumber(process.env.LAB_MAX_INTENTS_PER_CYCLE, 2))
    ),
  },
  strategy: {
    buyMomentumThreshold: parseNumber(process.env.LAB_BUY_MOMENTUM_THRESHOLD, 0.004),
    sellMomentumThreshold: parseNumber(process.env.LAB_SELL_MOMENTUM_THRESHOLD, -0.003),
    takeProfitPct: parseNumber(process.env.LAB_TAKE_PROFIT_PCT, 0.06),
    stopLossPct: parseNumber(process.env.LAB_STOP_LOSS_PCT, -0.04),
    maxHoldMinutes: Math.max(
      5,
      Math.floor(parseNumber(process.env.LAB_MAX_HOLD_MINUTES, 180))
    ),
    tradeAllocationPct: clamp(
      parseNumber(process.env.LAB_TRADE_ALLOCATION_PCT, 0.08),
      0.01,
      1
    ),
    minTradeSol: Math.max(0.001, parseNumber(process.env.LAB_MIN_TRADE_SOL, 0.1)),
    maxTradeSol: Math.max(0.001, parseNumber(process.env.LAB_MAX_TRADE_SOL, 1)),
    maxOpenPositions: Math.max(
      1,
      Math.floor(parseNumber(process.env.LAB_MAX_OPEN_POSITIONS, 3))
    ),
    sellFraction: clamp(parseNumber(process.env.LAB_SELL_FRACTION, 1), 0.05, 1),
    intentSlippageBps: Math.max(
      1,
      Math.floor(parseNumber(process.env.LAB_INTENT_SLIPPAGE_BPS, 100))
    ),
  },
  accounting: {
    initialCashSol: Math.max(0.1, parseNumber(process.env.LAB_INITIAL_CASH_SOL, 10)),
  },
  improve: {
    enabled: process.env.LAB_IMPROVE_ENABLED !== "false",
    proposalEveryCycles: Math.max(
      3,
      Math.floor(parseNumber(process.env.LAB_PROPOSAL_EVERY_CYCLES, 15))
    ),
    minHistoryPointsForEvaluation: Math.max(
      15,
      Math.floor(parseNumber(process.env.LAB_MIN_HISTORY_POINTS_FOR_EVALUATION, 40))
    ),
    minClosedTradesForProposal: Math.max(
      1,
      Math.floor(parseNumber(process.env.LAB_MIN_CLOSED_TRADES_FOR_PROPOSAL, 3))
    ),
    policyMutationScale: clamp(
      parseNumber(process.env.LAB_POLICY_MUTATION_SCALE, 0.2),
      0.01,
      1
    ),
    maxPendingCandidates: Math.max(
      1,
      Math.floor(parseNumber(process.env.LAB_MAX_PENDING_CANDIDATES, 8))
    ),
  },
  state: {
    dir: process.env.LAB_STATE_DIR ?? "/tmp/cashcat-runtime/lab-state",
  },
} as const;

export function findTokenByMint(mint: string): TokenConfig | undefined {
  return config.market.tokenUniverse.find((token) => token.mint === mint);
}
