import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { State, TradeIntent } from "./state.js";

const log = createLogger("safety");

const SOL_MINT = "So11111111111111111111111111111111111111112";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBigint(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function toNumber(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(num) ? num : 0;
}

function buildPriceUrl(mints: string[]): string {
  const url = new URL(`${config.jupiter.baseUrl}/price/v3`);
  url.searchParams.set("ids", mints.join(","));
  return url.toString();
}

async function fetchPricesUsd(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};

  const response = await fetch(buildPriceUrl(mints));
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`Jupiter price failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as
    | Record<string, unknown>
    | { data?: Record<string, unknown> };
  const data: Record<string, unknown> =
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data &&
    typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : (payload as Record<string, unknown>);

  const prices: Record<string, number> = {};
  for (const mint of mints) {
    const row = data[mint] as Record<string, unknown> | undefined;
    const price = toNumber(
      row?.usdPrice ?? row?.price ?? row?.priceUsd ?? row?.value
    );
    prices[mint] = price > 0 ? price : 0;
  }
  return prices;
}

function calcPositionPnlPct(
  costLamports: bigint,
  rawAmount: bigint,
  decimals: number,
  tokenPriceUsd: number,
  solPriceUsd: number
): number {
  if (rawAmount <= 0n || costLamports <= 0n || tokenPriceUsd <= 0 || solPriceUsd <= 0) {
    return 0;
  }
  const size = Number(rawAmount) / 10 ** decimals;
  const marketValueUsd = size * tokenPriceUsd;
  const costBasisUsd = (Number(costLamports) / 1_000_000_000) * solPriceUsd;
  if (costBasisUsd <= 0) return 0;
  return marketValueUsd / costBasisUsd - 1;
}

function calcSellRaw(rawAmount: bigint): bigint {
  if (rawAmount <= 0n) return 0n;

  if (config.sellFraction >= 0.999) {
    const adjusted = (rawAmount * 995n) / 1000n;
    return adjusted > 0n ? adjusted : rawAmount;
  }

  const ppm = BigInt(Math.max(1, Math.floor(config.sellFraction * 1_000_000)));
  const value = (rawAmount * ppm) / 1_000_000n;
  if (value > 0n) return value;
  return rawAmount;
}

function makeIntentId(symbol: string, action: "buy" | "sell"): string {
  return `agentic-${Date.now()}-${symbol.toLowerCase()}-${action}-${randomUUID().slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// checkStopLoss — returns sell intents for positions that hit stop-loss or max hold
// ---------------------------------------------------------------------------

export async function checkStopLoss(state: State): Promise<TradeIntent[]> {
  const positionMints = Object.keys(state.positions);
  if (positionMints.length === 0) return [];

  const allMints = [SOL_MINT, ...positionMints];
  let prices: Record<string, number>;
  try {
    prices = await fetchPricesUsd(allMints);
  } catch (e) {
    log.warn(`Stop-loss price fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const solPriceUsd = prices[SOL_MINT] ?? 0;
  if (solPriceUsd <= 0) {
    log.warn("SOL price unavailable, skipping stop-loss check");
    return [];
  }

  const nowMs = Date.now();
  const intents: TradeIntent[] = [];

  for (const [mint, position] of Object.entries(state.positions)) {
    const tokenPrice = prices[mint] ?? 0;
    const rawAmount = toBigint(position.rawAmount);
    const costLamports = toBigint(position.costLamports);

    const pnlPct = calcPositionPnlPct(
      costLamports,
      rawAmount,
      position.decimals,
      tokenPrice,
      solPriceUsd
    );

    const holdMinutes = Math.max(0, (nowMs - Date.parse(position.openedAt)) / 60_000);

    const isStopLoss = pnlPct <= config.stopLossPct;
    const isTimeout = holdMinutes >= config.maxHoldMinutes;
    const isTakeProfit = pnlPct >= config.takeProfitPct;

    if (!isStopLoss && !isTimeout && !isTakeProfit) continue;

    const sellRaw = calcSellRaw(rawAmount);
    if (sellRaw <= 0n) continue;

    const reason = isStopLoss
      ? `stop-loss pnl=${(pnlPct * 100).toFixed(2)}%`
      : isTakeProfit
        ? `take-profit pnl=${(pnlPct * 100).toFixed(2)}%`
        : `timeout hold=${holdMinutes.toFixed(0)}min`;

    log.info(`[StopLoss] ${position.symbol}: ${reason}`);

    intents.push({
      id: makeIntentId(position.symbol, "sell"),
      action: "sell",
      inputMint: mint,
      outputMint: SOL_MINT,
      amountLamports: Number(sellRaw),
      slippageBps: config.intentSlippageBps,
      metadata: {
        planner: "safety",
        tokenSymbol: position.symbol,
        reason,
        pnlPct,
        holdMinutes,
      },
    });
  }

  return intents;
}

// ---------------------------------------------------------------------------
// validateIntent — returns error reason string or null (valid)
// ---------------------------------------------------------------------------

export function validateIntent(intent: TradeIntent): string | null {
  if (config.killSwitch) {
    return "Global kill switch is enabled";
  }

  if (!intent.amountLamports || intent.amountLamports <= 0) {
    return "amountLamports must be positive";
  }

  if (intent.amountLamports > config.maxAmountLamports) {
    return `amountLamports exceeds max (${config.maxAmountLamports})`;
  }

  if (!intent.slippageBps || intent.slippageBps < 1) {
    return "slippageBps must be positive";
  }

  if (intent.slippageBps > config.maxSlippageBps) {
    return `slippageBps exceeds max (${config.maxSlippageBps})`;
  }

  if (!isValidMint(intent.inputMint)) {
    return "inputMint is invalid";
  }

  if (!isValidMint(intent.outputMint)) {
    return "outputMint is invalid";
  }

  if (intent.inputMint === intent.outputMint) {
    return "inputMint and outputMint must differ";
  }

  return null;
}

function isValidMint(value: string): boolean {
  if (!value || value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
