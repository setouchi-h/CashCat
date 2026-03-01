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
// checkStopLoss — returns sell intents for positions that hit stop-loss
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

  const intents: TradeIntent[] = [];

  for (const [mint, position] of Object.entries(state.positions)) {
    const tokenPrice = prices[mint] ?? 0;
    const rawAmount = toBigint(position.rawAmount);
    const costLamports = toBigint(position.costLamports);

    // Skip dust positions too small for Jupiter to execute (keep tracked for recovery)
    if (tokenPrice > 0 && position.decimals >= 0) {
      const valueUsd = (Number(rawAmount) / 10 ** position.decimals) * tokenPrice;
      if (valueUsd < config.minTradeValueUsd) {
        log.debug(`[StopLoss] ${position.symbol}: skipping dust position ($${valueUsd.toFixed(6)} < $${config.minTradeValueUsd})`);
        continue;
      }
    }

    const pnlPct = calcPositionPnlPct(
      costLamports,
      rawAmount,
      position.decimals,
      tokenPrice,
      solPriceUsd
    );

    if (pnlPct > config.stopLossPct) continue;

    const sellRaw = calcSellRaw(rawAmount);
    if (sellRaw <= 0n) continue;

    // Skip sell intent if the sell amount value is below minimum trade threshold
    if (tokenPrice > 0 && position.decimals >= 0) {
      const sellValueUsd = (Number(sellRaw) / 10 ** position.decimals) * tokenPrice;
      if (sellValueUsd < config.minTradeValueUsd) {
        log.info(`[StopLoss] ${position.symbol}: skipping sell, value $${sellValueUsd.toFixed(4)} below min $${config.minTradeValueUsd}`);
        continue;
      }
    }

    const reason = `stop-loss pnl=${(pnlPct * 100).toFixed(2)}%`;

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
      },
    });
  }

  return intents;
}

// ---------------------------------------------------------------------------
// checkPerpStopLoss — returns perp_close intents for positions that hit SL/TP/liquidation/timeout
// ---------------------------------------------------------------------------

export async function checkPerpStopLoss(state: State): Promise<TradeIntent[]> {
  if (!config.perps.enabled) return [];

  const markets = Object.keys(state.perpPositions);
  if (markets.length === 0) return [];

  const mintMap: Record<string, string> = {};
  for (const [market, pos] of Object.entries(state.perpPositions)) {
    if (pos.underlyingMint) mintMap[market] = pos.underlyingMint;
  }
  const underlyingMints = [...new Set(Object.values(mintMap))];
  if (underlyingMints.length === 0) return [];

  let prices: Record<string, number>;
  try {
    prices = await fetchPricesUsd(underlyingMints);
  } catch (e) {
    log.warn(`Perp stop-loss price fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const nowMs = Date.now();
  const intents: TradeIntent[] = [];

  for (const [market, pos] of Object.entries(state.perpPositions)) {
    const underlyingMint = pos.underlyingMint;
    if (!underlyingMint) continue;

    // Backoff: after 3+ consecutive close failures, retry only every 5 minutes
    if (pos.closeFailCount && pos.closeFailCount >= 3 && pos.lastCloseFailedAt) {
      const msSinceFail = nowMs - Date.parse(pos.lastCloseFailedAt);
      const backoffMs = 5 * 60 * 1000; // 5 minutes
      if (msSinceFail < backoffMs) {
        continue; // skip — still in backoff period
      }
      log.info(`[PerpStopLoss] ${market}: backoff expired (${pos.closeFailCount} prior failures), retrying close`);
    }

    const markPrice = prices[underlyingMint] ?? 0;
    if (markPrice <= 0) continue;

    // Accumulate borrow fee
    const holdHours = Math.max(0, (nowMs - Date.parse(pos.openedAt)) / 3_600_000);
    pos.borrowFeeUsd = pos.sizeUsd * config.perps.hourlyBorrowRate * holdHours;
    pos.updatedAt = new Date().toISOString();

    // PnL calculation
    const priceChange = (markPrice - pos.entryPriceUsd) / pos.entryPriceUsd;
    const rawPnl =
      pos.side === "long"
        ? pos.sizeUsd * priceChange
        : pos.sizeUsd * -priceChange;
    const netPnl = rawPnl - pos.borrowFeeUsd;
    const pnlPct = netPnl / pos.collateralUsd;

    const holdMinutes = holdHours * 60;

    // Check remaining collateral for liquidation
    const remainingCollateral = pos.collateralUsd + netPnl;
    const isLiquidation = remainingCollateral < pos.sizeUsd * config.perps.liquidationThreshold;
    const isStopLoss = pnlPct <= config.perps.stopLossPct;
    const isTimeout = holdMinutes >= config.perps.maxHoldMinutes;

    if (!isLiquidation && !isStopLoss && !isTimeout) continue;

    const reason = isLiquidation
      ? `liquidation collateral=$${remainingCollateral.toFixed(2)}`
      : isStopLoss
        ? `stop-loss pnl=${(pnlPct * 100).toFixed(2)}%`
        : `timeout hold=${holdMinutes.toFixed(0)}min`;

    log.info(`[PerpStopLoss] ${market} ${pos.side}: ${reason}`);

    intents.push({
      id: `agentic-${Date.now()}-${market.toLowerCase()}-perp_close-${randomUUID().slice(0, 6)}`,
      action: "perp_close",
      inputMint: underlyingMint,
      outputMint: "",
      amountLamports: 0,
      slippageBps: 0,
      metadata: {
        planner: "safety",
        perpMarket: market,
        reason,
        pnlPct,
        holdMinutes,
      },
    });
  }

  return intents;
}

// ---------------------------------------------------------------------------
// checkPerpWriteOffs — returns market names that should be written off
// ---------------------------------------------------------------------------

export function checkPerpWriteOffs(state: State): string[] {
  const writeOffs: string[] = [];
  const nowMs = Date.now();

  for (const [market, pos] of Object.entries(state.perpPositions)) {
    const failCount = pos.closeFailCount ?? 0;
    const openedMs = Date.parse(pos.openedAt);
    const openHours = (nowMs - openedMs) / 3_600_000;

    // Condition 1: 10+ consecutive close failures
    if (failCount >= 10) {
      writeOffs.push(market);
      continue;
    }

    // Condition 2: opened 24h+ AND 3+ close failures
    if (openHours >= 24 && failCount >= 3) {
      writeOffs.push(market);
    }
  }

  return writeOffs;
}

// ---------------------------------------------------------------------------
// validateIntent — returns error reason string or null (valid)
// ---------------------------------------------------------------------------

export function validateIntent(intent: TradeIntent): string | null {
  if (config.killSwitch) {
    return "Global kill switch is enabled";
  }

  // Perp intents use separate validation
  if (intent.action === "perp_open" || intent.action === "perp_close") {
    return validatePerpIntent(intent);
  }

  if (!intent.amountLamports || intent.amountLamports <= 0) {
    return "amountLamports must be positive";
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

function validatePerpIntent(intent: TradeIntent): string | null {
  if (!config.perps.enabled) {
    return "Perps are disabled";
  }

  const market = typeof intent.metadata?.perpMarket === "string"
    ? intent.metadata.perpMarket as string
    : "";
  if (!market) {
    return `Missing perp market name`;
  }

  if (intent.action === "perp_open") {
    const side = intent.metadata?.perpSide;
    if (side !== "long" && side !== "short") {
      return `Invalid perp side: ${side}`;
    }
    const leverage = typeof intent.metadata?.leverage === "number"
      ? intent.metadata.leverage as number
      : 0;
    if (leverage < 1 || leverage > config.perps.maxLeverage) {
      return `Leverage out of range: ${leverage} (max ${config.perps.maxLeverage})`;
    }
  }

  return null;
}

function isValidMint(value: string): boolean {
  if (!value || value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
