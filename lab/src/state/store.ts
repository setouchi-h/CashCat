import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import type { LabPolicy, LabState, PositionState } from "./types.js";

const STATE_FILE = "state.json";

function initialPolicy(): LabPolicy {
  return {
    buyMomentumThreshold: config.strategy.buyMomentumThreshold,
    sellMomentumThreshold: config.strategy.sellMomentumThreshold,
    takeProfitPct: config.strategy.takeProfitPct,
    stopLossPct: config.strategy.stopLossPct,
    maxHoldMinutes: config.strategy.maxHoldMinutes,
    tradeAllocationPct: config.strategy.tradeAllocationPct,
    minTradeSol: config.strategy.minTradeSol,
    maxTradeSol: config.strategy.maxTradeSol,
    maxOpenPositions: config.strategy.maxOpenPositions,
    sellFraction: config.strategy.sellFraction,
    intentSlippageBps: config.strategy.intentSlippageBps,
  };
}

function initialCashLamports(): string {
  return String(Math.floor(config.accounting.initialCashSol * 1_000_000_000));
}

function sanitizePosition(position: PositionState): PositionState {
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

function uniqueRecent(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (!v || seen.has(v)) continue;
    seen.add(v);
    result.push(v);
    if (result.length >= max) break;
  }
  return result.reverse();
}

function sanitizeState(raw: LabState): LabState {
  const now = new Date().toISOString();
  const positions: Record<string, PositionState> = {};
  for (const [mint, pos] of Object.entries(raw.positions ?? {})) {
    positions[mint] = sanitizePosition(pos as PositionState);
  }

  const policy = {
    ...initialPolicy(),
    ...(raw.policy ?? {}),
  };

  const marketHistory: LabState["marketHistory"] = {};
  for (const [mint, points] of Object.entries(raw.marketHistory ?? {})) {
    const next = (Array.isArray(points) ? points : [])
      .filter((point) => point && Number.isFinite(point.ts) && Number.isFinite(point.priceUsd))
      .map((point) => ({
        ts: Number(point.ts),
        priceUsd: Number(point.priceUsd),
      }))
      .slice(-config.market.historyKeepPoints);
    if (next.length > 0) marketHistory[mint] = next;
  }

  return {
    cycle: Number.isFinite(raw.cycle) ? Math.max(0, Math.floor(raw.cycle)) : 0,
    cashLamports: normalizeBigintString(raw.cashLamports),
    realizedPnlLamports: normalizeBigintString(raw.realizedPnlLamports),
    closedTradePnlsLamports: (raw.closedTradePnlsLamports ?? [])
      .map((v) => normalizeBigintString(v))
      .slice(-2000),
    equityCurveLamports: (raw.equityCurveLamports ?? [])
      .map((v) => normalizeBigintString(v))
      .slice(-2000),
    positions,
    issuedIntents: raw.issuedIntents ?? {},
    processedResultFiles: uniqueRecent(raw.processedResultFiles ?? [], 6000),
    processedVerdictFiles: uniqueRecent(raw.processedVerdictFiles ?? [], 6000),
    marketHistory,
    lastIntentAt: raw.lastIntentAt ?? {},
    policy,
    pendingCandidates: raw.pendingCandidates ?? {},
    filledCount:
      Number.isFinite(raw.filledCount) && raw.filledCount >= 0
        ? Math.floor(raw.filledCount)
        : 0,
    failedCount:
      Number.isFinite(raw.failedCount) && raw.failedCount >= 0
        ? Math.floor(raw.failedCount)
        : 0,
    updatedAt: raw.updatedAt || now,
  };
}

function buildInitialState(): LabState {
  return {
    cycle: 0,
    cashLamports: initialCashLamports(),
    realizedPnlLamports: "0",
    closedTradePnlsLamports: [],
    equityCurveLamports: [initialCashLamports()],
    positions: {},
    issuedIntents: {},
    processedResultFiles: [],
    processedVerdictFiles: [],
    marketHistory: {},
    lastIntentAt: {},
    policy: initialPolicy(),
    pendingCandidates: {},
    filledCount: 0,
    failedCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

export async function loadState(): Promise<LabState> {
  await fs.mkdir(config.state.dir, { recursive: true });
  const filePath = path.join(config.state.dir, STATE_FILE);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) {
    const state = buildInitialState();
    await saveState(state);
    return state;
  }

  try {
    const parsed = JSON.parse(raw) as LabState;
    const state = sanitizeState(parsed);
    return state;
  } catch {
    const state = buildInitialState();
    await saveState(state);
    return state;
  }
}

export async function saveState(state: LabState): Promise<void> {
  const next = sanitizeState({
    ...state,
    updatedAt: new Date().toISOString(),
  });

  const filePath = path.join(config.state.dir, STATE_FILE);
  const tempPath = filePath + ".tmp";
  await fs.mkdir(config.state.dir, { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2));
  await fs.rename(tempPath, filePath);
}
