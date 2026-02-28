import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Position {
  mint: string;
  symbol: string;
  decimals: number;
  rawAmount: string;
  costLamports: string;
  openedAt: string;
  updatedAt: string;
}

export interface PerpPosition {
  market: string;
  side: "long" | "short";
  leverage: number;
  sizeUsd: number;
  collateralUsd: number;
  entryPriceUsd: number;
  liquidationPriceUsd: number;
  borrowFeeUsd: number;
  openedAt: string;
  updatedAt: string;
}

export interface State {
  cycle: number;
  cashLamports: string;
  initialCashLamports?: string;
  realizedPnlLamports: string;
  positions: Record<string, Position>;
  lastIntentAt: Record<string, number>;
  filledCount: number;
  failedCount: number;
  updatedAt: string;
  // Perp paper trading (independent from wallet)
  perpPositions: Record<string, PerpPosition>;
  perpBalanceUsd: number;
  realizedPerpPnlUsd: number;
}

export interface TradeIntent {
  id: string;
  action: "buy" | "sell" | "perp_open" | "perp_close";
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
  metadata: Record<string, unknown>;
}

export interface TradeResult {
  success: boolean;
  txHash?: string;
  inputAmount: string;
  outputAmount: string;
  error?: string;
}

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

function normalizeBigintString(value: unknown): string {
  if (typeof value === "string") {
    try {
      return BigInt(value).toString();
    } catch {
      return "0";
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.floor(value)).toString();
  }
  return "0";
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------
// Build / sanitize
// ---------------------------------------------------------------------------

function initialCashLamports(): string {
  return String(Math.floor(config.initialCashSol * 1_000_000_000));
}

function sanitizePosition(position: Position): Position {
  return {
    mint: position.mint,
    symbol: position.symbol,
    decimals: Number.isFinite(position.decimals) ? position.decimals : 0,
    rawAmount: normalizeBigintString(position.rawAmount),
    costLamports: normalizeBigintString(position.costLamports),
    openedAt: position.openedAt || new Date().toISOString(),
    updatedAt: position.updatedAt || new Date().toISOString(),
  };
}

export function buildInitialState(realCashLamports?: string): State {
  const cash = realCashLamports ?? initialCashLamports();
  return {
    cycle: 0,
    cashLamports: cash,
    initialCashLamports: cash,
    realizedPnlLamports: "0",
    positions: {},
    lastIntentAt: {},
    filledCount: 0,
    failedCount: 0,
    updatedAt: new Date().toISOString(),
    perpPositions: {},
    perpBalanceUsd: config.perps.initialBalanceUsd,
    realizedPerpPnlUsd: 0,
  };
}

function sanitizePerpPosition(pos: PerpPosition): PerpPosition {
  return {
    market: pos.market || "",
    side: pos.side === "short" ? "short" : "long",
    leverage: Number.isFinite(pos.leverage) && pos.leverage > 0 ? pos.leverage : 1,
    sizeUsd: Number.isFinite(pos.sizeUsd) && pos.sizeUsd >= 0 ? pos.sizeUsd : 0,
    collateralUsd: Number.isFinite(pos.collateralUsd) && pos.collateralUsd >= 0 ? pos.collateralUsd : 0,
    entryPriceUsd: Number.isFinite(pos.entryPriceUsd) && pos.entryPriceUsd > 0 ? pos.entryPriceUsd : 0,
    liquidationPriceUsd: Number.isFinite(pos.liquidationPriceUsd) && pos.liquidationPriceUsd >= 0 ? pos.liquidationPriceUsd : 0,
    borrowFeeUsd: Number.isFinite(pos.borrowFeeUsd) && pos.borrowFeeUsd >= 0 ? pos.borrowFeeUsd : 0,
    openedAt: pos.openedAt || new Date().toISOString(),
    updatedAt: pos.updatedAt || new Date().toISOString(),
  };
}

function sanitizeState(state: State): State {
  const positions: Record<string, Position> = {};
  for (const [mint, pos] of Object.entries(state.positions ?? {})) {
    positions[mint] = sanitizePosition(pos as Position);
  }

  const perpPositions: Record<string, PerpPosition> = {};
  for (const [market, pos] of Object.entries(state.perpPositions ?? {})) {
    perpPositions[market] = sanitizePerpPosition(pos as PerpPosition);
  }

  return {
    cycle: Number.isFinite(state.cycle) ? Math.max(0, Math.floor(state.cycle)) : 0,
    cashLamports: normalizeBigintString(state.cashLamports),
    initialCashLamports: state.initialCashLamports
      ? normalizeBigintString(state.initialCashLamports)
      : undefined,
    realizedPnlLamports: normalizeBigintString(state.realizedPnlLamports),
    positions,
    lastIntentAt: state.lastIntentAt ?? {},
    filledCount:
      Number.isFinite(state.filledCount) && state.filledCount >= 0
        ? Math.floor(state.filledCount)
        : 0,
    failedCount:
      Number.isFinite(state.failedCount) && state.failedCount >= 0
        ? Math.floor(state.failedCount)
        : 0,
    updatedAt: state.updatedAt || new Date().toISOString(),
    perpPositions,
    perpBalanceUsd: Number.isFinite(state.perpBalanceUsd) ? state.perpBalanceUsd : config.perps.initialBalanceUsd,
    realizedPerpPnlUsd: Number.isFinite(state.realizedPerpPnlUsd) ? state.realizedPerpPnlUsd : 0,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(path.dirname(config.statePath), { recursive: true });
}

export async function loadState(realCashLamports?: string): Promise<State> {
  await ensureStateDir();
  const raw = await fs.readFile(config.statePath, "utf8").catch(() => "");
  if (!raw) {
    const initial = buildInitialState(realCashLamports);
    await saveState(initial);
    return initial;
  }

  try {
    const parsed = JSON.parse(raw) as State;
    return sanitizeState(parsed);
  } catch {
    const initial = buildInitialState(realCashLamports);
    await saveState(initial);
    return initial;
  }
}

export async function saveState(state: State): Promise<void> {
  const next = sanitizeState({
    ...state,
    updatedAt: new Date().toISOString(),
  });

  await ensureStateDir();
  const tempPath = config.statePath + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2));
  await fs.rename(tempPath, config.statePath);
}

// ---------------------------------------------------------------------------
// State mutations: applyBuy / applySell
// ---------------------------------------------------------------------------

export function applyBuy(
  state: State,
  intent: TradeIntent,
  result: TradeResult
): void {
  if (!result.success) {
    state.failedCount++;
    return;
  }
  state.filledCount++;

  const inLamports = toBigint(result.inputAmount);
  const outRaw = toBigint(result.outputAmount);
  if (inLamports <= 0n || outRaw <= 0n) return;

  const symbol =
    typeof intent.metadata?.tokenSymbol === "string" && intent.metadata.tokenSymbol
      ? (intent.metadata.tokenSymbol as string)
      : intent.outputMint.slice(0, 6);
  const decimals =
    typeof intent.metadata?.decimals === "number" ? (intent.metadata.decimals as number) : 9;
  const existing = state.positions[intent.outputMint];
  const now = new Date().toISOString();

  state.positions[intent.outputMint] = existing
    ? {
        ...existing,
        rawAmount: (toBigint(existing.rawAmount) + outRaw).toString(),
        costLamports: (toBigint(existing.costLamports) + inLamports).toString(),
        updatedAt: now,
      }
    : {
        mint: intent.outputMint,
        symbol,
        decimals,
        rawAmount: outRaw.toString(),
        costLamports: inLamports.toString(),
        openedAt: now,
        updatedAt: now,
      };

  const currentCash = toBigint(state.cashLamports);
  state.cashLamports = (
    currentCash > inLamports ? currentCash - inLamports : 0n
  ).toString();
}

export function applySell(
  state: State,
  intent: TradeIntent,
  result: TradeResult
): string | undefined {
  if (!result.success) {
    state.failedCount++;
    return undefined;
  }
  state.filledCount++;

  const requestedRaw = toBigint(result.inputAmount);
  const outLamports = toBigint(result.outputAmount);
  if (requestedRaw <= 0n || outLamports <= 0n) return undefined;

  const position = state.positions[intent.inputMint];
  if (!position) {
    state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
    return undefined;
  }

  const rawAmount = toBigint(position.rawAmount);
  const costLamports = toBigint(position.costLamports);
  if (rawAmount <= 0n) {
    delete state.positions[intent.inputMint];
    state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
    return undefined;
  }

  const soldRaw = minBigint(rawAmount, requestedRaw);
  const allocatedCost = (costLamports * soldRaw) / rawAmount;
  const pnlLamports = outLamports - allocatedCost;

  const remainingRaw = rawAmount - soldRaw;
  const remainingCost = costLamports - allocatedCost;

  const dustThreshold = rawAmount / 100n;
  if (remainingRaw <= 0n || remainingRaw <= dustThreshold) {
    delete state.positions[intent.inputMint];
  } else {
    state.positions[intent.inputMint] = {
      ...position,
      rawAmount: remainingRaw.toString(),
      costLamports: remainingCost.toString(),
      updatedAt: new Date().toISOString(),
    };
  }

  state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
  state.realizedPnlLamports = (
    toBigint(state.realizedPnlLamports) + pnlLamports
  ).toString();
  return pnlLamports.toString();
}

// ---------------------------------------------------------------------------
// State mutations: applyPerpOpen / applyPerpClose
// ---------------------------------------------------------------------------

export function applyPerpOpen(
  state: State,
  market: string,
  side: "long" | "short",
  leverage: number,
  collateralUsd: number,
  entryPriceUsd: number
): void {
  const fee = collateralUsd * leverage * config.perps.openCloseFeeRate;
  state.perpBalanceUsd -= collateralUsd + fee;

  const sizeUsd = collateralUsd * leverage;
  const liqDistance = collateralUsd / sizeUsd;
  const liquidationPriceUsd =
    side === "long"
      ? entryPriceUsd * (1 - liqDistance)
      : entryPriceUsd * (1 + liqDistance);

  const now = new Date().toISOString();
  state.perpPositions[market] = {
    market,
    side,
    leverage,
    sizeUsd,
    collateralUsd,
    entryPriceUsd,
    liquidationPriceUsd,
    borrowFeeUsd: 0,
    openedAt: now,
    updatedAt: now,
  };
}

export function applyPerpClose(
  state: State,
  market: string,
  closePriceUsd: number
): { pnlUsd: number; reason?: string } {
  const pos = state.perpPositions[market];
  if (!pos) return { pnlUsd: 0, reason: "no position" };

  const priceChange = (closePriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
  const rawPnl =
    pos.side === "long"
      ? pos.sizeUsd * priceChange
      : pos.sizeUsd * -priceChange;

  const closeFee = pos.sizeUsd * config.perps.openCloseFeeRate;
  const pnlUsd = rawPnl - pos.borrowFeeUsd - closeFee;

  state.perpBalanceUsd += pos.collateralUsd + pnlUsd;
  state.realizedPerpPnlUsd += pnlUsd;
  delete state.perpPositions[market];

  return { pnlUsd };
}

export function applyResult(
  state: State,
  intent: TradeIntent,
  result: TradeResult
): string | undefined {
  if (intent.action === "buy") {
    applyBuy(state, intent, result);
    return undefined;
  }
  if (intent.action === "sell") {
    return applySell(state, intent, result);
  }
  return undefined;
}

export function getSummary(state: State): string {
  const cashSol = Number(toBigint(state.cashLamports)) / 1_000_000_000;
  const realizedSol = Number(toBigint(state.realizedPnlLamports)) / 1_000_000_000;
  const perpCount = Object.keys(state.perpPositions).length;
  const perpSuffix = perpCount > 0 || state.realizedPerpPnlUsd !== 0
    ? `, perpBal=$${state.perpBalanceUsd.toFixed(2)}, perpPnl=$${state.realizedPerpPnlUsd.toFixed(2)}, perps=${perpCount}`
    : "";
  return `cash=${cashSol.toFixed(4)} SOL, realized=${realizedSol.toFixed(4)} SOL, positions=${Object.keys(state.positions).length}, fills=${state.filledCount}, fails=${state.failedCount}${perpSuffix}`;
}
