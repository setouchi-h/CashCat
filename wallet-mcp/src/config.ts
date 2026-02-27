import "dotenv/config";

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptional(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

export const config = {
  server: {
    name: "cashcat-wallet-mcp",
    version: "0.1.0",
    protocolVersion: "2024-11-05",
  },
  solana: {
    privateKey: parseOptional(process.env.SOLANA_PRIVATE_KEY) ?? "",
    rpcUrl:
      parseOptional(process.env.SOLANA_RPC_URL) ??
      "https://api.mainnet-beta.solana.com",
  },
  jupiter: {
    apiKey: parseOptional(process.env.JUPITER_API_KEY) ?? "",
    baseUrl:
      parseOptional(process.env.JUPITER_API_BASE_URL) ??
      (parseOptional(process.env.JUPITER_API_KEY)
        ? "https://api.jup.ag"
        : "https://lite-api.jup.ag"),
  },
  paperTrade: process.env.PAPER_TRADE !== "false",
  policy: {
    killSwitch: process.env.WALLET_MCP_KILL_SWITCH === "true",
    maxSlippageBps: parsePositiveInteger(
      process.env.WALLET_MCP_MAX_SLIPPAGE_BPS,
      300
    ),
    allowedInputMints: parseCsv(process.env.WALLET_MCP_ALLOWED_INPUT_MINTS),
    allowedOutputMints: parseCsv(process.env.WALLET_MCP_ALLOWED_OUTPUT_MINTS),
  },
  quotes: {
    ttlSeconds: parsePositiveInteger(process.env.WALLET_MCP_QUOTE_TTL_SECONDS, 90),
  },
  ledger: {
    path:
      parseOptional(process.env.WALLET_MCP_LEDGER_PATH) ??
      "/tmp/cashcat-runtime/wallet-mcp/ledger.jsonl",
  },
} as const;
