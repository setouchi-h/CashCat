import {
  VersionedTransaction,
} from "@solana/web3.js";
import { getConnection, getKeypair } from "./wallet.js";
import { createLogger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import type { SwapParams, SwapQuote, TradeOrder, TradeResult } from "../types.js";

const log = createLogger("solana:swap");

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";

export async function getJupiterQuote(params: SwapParams): Promise<SwapQuote> {
  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", String(params.amountLamports));
  url.searchParams.set("slippageBps", String(params.slippageBps));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct: string;
    slippageBps: number;
  };

  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: data.inAmount,
    outAmount: data.outAmount,
    priceImpactPct: Number(data.priceImpactPct),
    slippageBps: data.slippageBps,
  };
}

export async function executeSwap(trade: TradeOrder): Promise<TradeResult> {
  if (config.paperTrade) {
    return executePaperSwap(trade);
  }

  try {
    // 1. Get quote
    const quote = await getJupiterQuote({
      inputMint: trade.inputMint,
      outputMint: trade.outputMint,
      amountLamports: trade.amountLamports,
      slippageBps: trade.slippageBps,
    });

    log.info(`Quote: ${quote.inAmount} -> ${quote.outAmount} (impact: ${quote.priceImpactPct}%)`);

    // 2. Get swap transaction
    const keypair = getKeypair();
    const swapRes = await fetch(JUPITER_SWAP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });

    if (!swapRes.ok) {
      throw new Error(`Jupiter swap failed: ${swapRes.status} ${await swapRes.text()}`);
    }

    const { swapTransaction } = (await swapRes.json()) as {
      swapTransaction: string;
    };

    // 3. Sign and send
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const conn = getConnection();
    const txHash = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });

    // 4. Confirm
    const latestBlockhash = await conn.getLatestBlockhash();
    await conn.confirmTransaction({
      signature: txHash,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    log.info(`Swap executed: ${txHash}`);

    return {
      success: true,
      txHash,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`Swap failed: ${msg}`);
    return {
      success: false,
      inputAmount: String(trade.amountLamports),
      outputAmount: "0",
      error: msg,
    };
  }
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
