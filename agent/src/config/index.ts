import "dotenv/config";

export type LlmProvider = "chatgpt-oauth" | "anthropic";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export const config = {
  llmProvider: (process.env.LLM_PROVIDER ?? "chatgpt-oauth") as LlmProvider,
  solana: {
    privateKey: process.env.SOLANA_PRIVATE_KEY ?? "",
    rpcUrl: process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : "https://api.mainnet-beta.solana.com",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-5.2",
    reasoningEffort: (process.env.OPENAI_REASONING_EFFORT ?? "medium") as ReasoningEffort,
  },
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY ?? "",
  },
  paperTrade: process.env.PAPER_TRADE !== "false",
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES) || 5,
  risk: {
    maxTradePercent: 5,
    dailyLossLimitPercent: 10,
    maxPositions: 5,
    minLiquidityUsd: 10_000,
    maxSlippageBps: 100, // 1%
    minConfidence: 0.7,
  },
} as const;
