import { createLogger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import type { TradeOrder, TradeResult } from "../types.js";

const log = createLogger("solana:swap");

const JUPITER_QUOTE_API = `${config.jupiter.baseUrl}/swap/v1/quote`;

function getJupiterHeaders(): HeadersInit {
  const headers: Record<string, string> = {};
  if (config.jupiter.apiKey) headers["x-api-key"] = config.jupiter.apiKey;
  return headers;
}

interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  slippageBps: number;
  quoteResponse?: unknown;
}

async function getJupiterQuote(params: JupiterQuoteParams): Promise<JupiterQuote> {
  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", String(params.amountLamports));
  url.searchParams.set("slippageBps", String(params.slippageBps));

  const res = await fetch(url.toString(), {
    headers: getJupiterHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct?: string;
    slippageBps?: number;
  };

  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: data.inAmount,
    outAmount: data.outAmount,
    priceImpactPct: Number(data.priceImpactPct ?? 0),
    slippageBps: Number(data.slippageBps ?? params.slippageBps),
    quoteResponse: data,
  };
}

export async function executeSwap(trade: TradeOrder): Promise<TradeResult> {
  if (!config.paperTrade) {
    throw new Error(
      "Live swap via agent is disabled. Use wallet-mcp for live trades."
    );
  }

  return executePaperSwap(trade);
}

async function executePaperSwap(trade: TradeOrder): Promise<TradeResult> {
  try {
    const quote = await getJupiterQuote({
      inputMint: trade.inputMint,
      outputMint: trade.outputMint,
      amountLamports: trade.amountLamports,
      slippageBps: trade.slippageBps,
    });

    log.info(`[PAPER] Swap: ${quote.inAmount} -> ${quote.outAmount} (impact: ${quote.priceImpactPct}%)`);

    return {
      success: true,
      txHash: `paper_${Date.now()}`,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`[PAPER] Swap quote failed: ${msg}`);
    return {
      success: false,
      inputAmount: String(trade.amountLamports),
      outputAmount: "0",
      error: msg,
    };
  }
}
