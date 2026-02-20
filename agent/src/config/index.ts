import "dotenv/config";

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  solana: {
    privateKey: process.env.SOLANA_PRIVATE_KEY ?? "",
    rpcUrl: process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : "https://api.mainnet-beta.solana.com",
  },
  jupiter: {
    apiKey: process.env.JUPITER_API_KEY ?? "",
    baseUrl: process.env.JUPITER_API_BASE_URL
      ?? (process.env.JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag"),
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
        Number(process.env.RUNTIME_GATE_MAX_DRAWDOWN_DELTA_PCT) || 0,
      minTestPassRate:
        Number(process.env.RUNTIME_GATE_MIN_TEST_PASS_RATE) || 0.98,
    },
  },
} as const;
