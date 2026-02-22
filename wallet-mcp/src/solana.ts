import { randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "./config.js";
import { appendLedgerEvent } from "./ledger.js";
import { createLogger } from "./logger.js";

const log = createLogger("solana");

const JUPITER_QUOTE_API = `${config.jupiter.baseUrl}/swap/v1/quote`;
const JUPITER_SWAP_API = `${config.jupiter.baseUrl}/swap/v1/swap`;

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string | number;
  slippageBps?: number;
  [key: string]: unknown;
}

interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
}

export interface StoredQuote {
  quoteId: string;
  createdAtMs: number;
  expiresAtMs: number;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct: number;
  quoteResponse: JupiterQuoteResponse;
}

export interface SwapExecutionResult {
  intentId: string;
  status: "filled" | "failed";
  chain: "solana";
  txHash?: string;
  quoteId: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  error?: string;
  createdAt: string;
}

let connection: Connection | null = null;
let keypair: Keypair | null = null;

const quoteCache = new Map<string, StoredQuote>();

function getJupiterHeaders(withJson = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (withJson) headers["Content-Type"] = "application/json";
  if (config.jupiter.apiKey) headers["x-api-key"] = config.jupiter.apiKey;
  return headers;
}

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.solana.rpcUrl, "confirmed");
    log.info(
      `Connected to ${config.solana.rpcUrl.replace(/api-key=.*/, "api-key=***")}`
    );
  }
  return connection;
}

function getKeypair(): Keypair {
  if (!keypair) {
    if (!config.solana.privateKey) {
      throw new Error("SOLANA_PRIVATE_KEY is not set");
    }
    const decoded = Buffer.from(config.solana.privateKey, "base64");
    keypair = Keypair.fromSecretKey(decoded);
    log.info(`Wallet loaded: ${keypair.publicKey.toBase58()}`);
  }
  return keypair;
}

function pruneQuoteCache(nowMs: number = Date.now()): void {
  for (const [id, quote] of quoteCache.entries()) {
    if (quote.expiresAtMs <= nowMs) quoteCache.delete(id);
  }
}

function parsePriceImpactPct(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function requestQuote(req: QuoteRequest): Promise<StoredQuote> {
  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set("inputMint", req.inputMint);
  url.searchParams.set("outputMint", req.outputMint);
  url.searchParams.set("amount", String(req.amountLamports));
  url.searchParams.set("slippageBps", String(req.slippageBps));

  const response = await fetch(url.toString(), { headers: getJupiterHeaders() });
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as JupiterQuoteResponse;
  const nowMs = Date.now();
  const quoteId = randomUUID();
  const quote: StoredQuote = {
    quoteId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + config.quotes.ttlSeconds * 1000,
    inputMint: payload.inputMint,
    outputMint: payload.outputMint,
    inAmount: payload.inAmount,
    outAmount: payload.outAmount,
    slippageBps: Number(payload.slippageBps ?? req.slippageBps),
    priceImpactPct: parsePriceImpactPct(payload.priceImpactPct),
    quoteResponse: payload,
  };

  quoteCache.set(quoteId, quote);
  pruneQuoteCache(nowMs);

  await appendLedgerEvent("quote_issued", {
    quoteId: quote.quoteId,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    slippageBps: quote.slippageBps,
    priceImpactPct: quote.priceImpactPct,
    expiresAt: new Date(quote.expiresAtMs).toISOString(),
  });

  return quote;
}

export function getStoredQuote(quoteId: string): StoredQuote | null {
  pruneQuoteCache();
  return quoteCache.get(quoteId) ?? null;
}

export function getWalletAddress(): string {
  return getKeypair().publicKey.toBase58();
}

export async function getBalance(account?: string): Promise<{
  chain: "solana";
  account: string;
  lamports: string;
  sol: string;
}> {
  const pubkey = account
    ? new PublicKey(account)
    : new PublicKey(getWalletAddress());
  const lamports = await getConnection().getBalance(pubkey, "confirmed");

  await appendLedgerEvent("balance_checked", {
    account: pubkey.toBase58(),
    lamports,
  });

  return {
    chain: "solana",
    account: pubkey.toBase58(),
    lamports: String(lamports),
    sol: (lamports / 1_000_000_000).toFixed(9),
  };
}

export async function getQuote(req: QuoteRequest): Promise<{
  chain: "solana";
  quoteId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct: number;
  expiresAt: string;
}> {
  const quote = await requestQuote(req);

  return {
    chain: "solana",
    quoteId: quote.quoteId,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    slippageBps: quote.slippageBps,
    priceImpactPct: quote.priceImpactPct,
    expiresAt: new Date(quote.expiresAtMs).toISOString(),
  };
}

export async function executeSwap(params: {
  intentId?: string;
  quoteId?: string;
  quoteRequest?: QuoteRequest;
}): Promise<SwapExecutionResult> {
  const createdAt = new Date().toISOString();
  const intentId = params.intentId ?? `mcp-${Date.now()}`;
  let resolvedQuote: StoredQuote | null = null;

  try {
    const cachedQuote = params.quoteId ? getStoredQuote(params.quoteId) : null;
    resolvedQuote = cachedQuote ?? (params.quoteRequest ? await requestQuote(params.quoteRequest) : null);
    if (!resolvedQuote) {
      throw new Error(
        "Quote not found or expired. Provide quoteId or pass full quoteRequest."
      );
    }

    if (config.paperTrade) {
      const paperResult: SwapExecutionResult = {
        intentId,
        status: "filled",
        chain: "solana",
        txHash: `paper_${Date.now()}`,
        quoteId: resolvedQuote.quoteId,
        inputMint: resolvedQuote.inputMint,
        outputMint: resolvedQuote.outputMint,
        inputAmount: resolvedQuote.inAmount,
        outputAmount: resolvedQuote.outAmount,
        createdAt,
      };

      await appendLedgerEvent("swap_filled", {
        intentId: paperResult.intentId,
        txHash: paperResult.txHash,
        mode: "paper",
        quoteId: paperResult.quoteId,
        inputMint: paperResult.inputMint,
        outputMint: paperResult.outputMint,
        inputAmount: paperResult.inputAmount,
        outputAmount: paperResult.outputAmount,
      });

      return paperResult;
    }

    const wallet = getKeypair();
    const swapResponse = await fetch(JUPITER_SWAP_API, {
      method: "POST",
      headers: getJupiterHeaders(true),
      body: JSON.stringify({
        quoteResponse: resolvedQuote.quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: { maxBps: config.policy.maxSlippageBps },
        prioritizationFeeLamports: "auto",
      }),
    });

    if (!swapResponse.ok) {
      throw new Error(
        `Jupiter swap failed: ${swapResponse.status} ${await swapResponse.text()}`
      );
    }

    const data = (await swapResponse.json()) as { swapTransaction?: string };
    if (!data.swapTransaction) {
      throw new Error("Jupiter swap response missing swapTransaction");
    }

    const txBuffer = Buffer.from(data.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([wallet]);

    const conn = getConnection();
    const txHash = await conn.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });

    const latestBlockhash = await conn.getLatestBlockhash();
    await conn.confirmTransaction({
      signature: txHash,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    const result: SwapExecutionResult = {
      intentId,
      status: "filled",
      chain: "solana",
      txHash,
      quoteId: resolvedQuote.quoteId,
      inputMint: resolvedQuote.inputMint,
      outputMint: resolvedQuote.outputMint,
      inputAmount: resolvedQuote.inAmount,
      outputAmount: resolvedQuote.outAmount,
      createdAt,
    };

    await appendLedgerEvent("swap_filled", {
      intentId: result.intentId,
      txHash: result.txHash,
      mode: "live",
      quoteId: result.quoteId,
      inputMint: result.inputMint,
      outputMint: result.outputMint,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const failedResult: SwapExecutionResult = {
      intentId,
      status: "failed",
      chain: "solana",
      quoteId: resolvedQuote?.quoteId ?? params.quoteId ?? "n/a",
      inputMint: resolvedQuote?.inputMint ?? params.quoteRequest?.inputMint ?? "n/a",
      outputMint:
        resolvedQuote?.outputMint ?? params.quoteRequest?.outputMint ?? "n/a",
      inputAmount: resolvedQuote?.inAmount ?? String(params.quoteRequest?.amountLamports ?? 0),
      outputAmount: "0",
      error: message,
      createdAt,
    };

    await appendLedgerEvent("swap_failed", {
      intentId: failedResult.intentId,
      quoteId: failedResult.quoteId,
      error: message,
    });

    return failedResult;
  }
}

export async function getTransactionStatus(txHash: string): Promise<{
  chain: "solana";
  txHash: string;
  found: boolean;
  confirmationStatus?: string;
  confirmations?: number | null;
  slot?: number;
  error?: unknown;
}> {
  const statuses = await getConnection().getSignatureStatuses([txHash], {
    searchTransactionHistory: true,
  });
  const status = statuses.value[0];

  if (!status) {
    await appendLedgerEvent("tx_checked", { txHash, found: false });
    return {
      chain: "solana",
      txHash,
      found: false,
    };
  }

  await appendLedgerEvent("tx_checked", {
    txHash,
    found: true,
    confirmationStatus: status.confirmationStatus ?? "unknown",
    confirmations: status.confirmations ?? null,
    slot: status.slot,
    hasError: Boolean(status.err),
  });

  return {
    chain: "solana",
    txHash,
    found: true,
    confirmationStatus: status.confirmationStatus ?? "unknown",
    confirmations: status.confirmations ?? null,
    slot: status.slot,
    error: status.err ?? undefined,
  };
}
