import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import type { AgenticPosition, AgenticState } from "./types.js";

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

function initialCashLamports(): string {
  return String(Math.floor(config.runtime.agentic.initialCashSol * 1_000_000_000));
}

function sanitizePosition(position: AgenticPosition): AgenticPosition {
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

function buildInitialState(realCashLamports?: string): AgenticState {
  const cash = realCashLamports ?? initialCashLamports();
  return {
    cycle: 0,
    cashLamports: cash,
    initialCashLamports: cash,
    realizedPnlLamports: "0",
    positions: {},
    marketHistory: {},
    lastIntentAt: {},
    filledCount: 0,
    failedCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeState(state: AgenticState): AgenticState {
  const positions: Record<string, AgenticPosition> = {};
  for (const [mint, pos] of Object.entries(state.positions ?? {})) {
    positions[mint] = sanitizePosition(pos as AgenticPosition);
  }

  const marketHistory: AgenticState["marketHistory"] = {};
  for (const [mint, points] of Object.entries(state.marketHistory ?? {})) {
    const next = (Array.isArray(points) ? points : [])
      .filter((point) => point && Number.isFinite(point.ts) && Number.isFinite(point.priceUsd))
      .map((point) => ({
        ts: Number(point.ts),
        priceUsd: Number(point.priceUsd),
      }))
      .slice(-config.runtime.agentic.historyKeepPoints);
    if (next.length > 0) marketHistory[mint] = next;
  }

  return {
    cycle: Number.isFinite(state.cycle) ? Math.max(0, Math.floor(state.cycle)) : 0,
    cashLamports: normalizeBigintString(state.cashLamports),
    initialCashLamports: state.initialCashLamports
      ? normalizeBigintString(state.initialCashLamports)
      : undefined,
    realizedPnlLamports: normalizeBigintString(state.realizedPnlLamports),
    positions,
    marketHistory,
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
  };
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(path.dirname(config.runtime.agentic.statePath), { recursive: true });
}

export async function loadAgenticState(realCashLamports?: string): Promise<AgenticState> {
  await ensureStateDir();
  const raw = await fs
    .readFile(config.runtime.agentic.statePath, "utf8")
    .catch(() => "");
  if (!raw) {
    const initial = buildInitialState(realCashLamports);
    await saveAgenticState(initial);
    return initial;
  }

  try {
    const parsed = JSON.parse(raw) as AgenticState;
    return sanitizeState(parsed);
  } catch {
    const initial = buildInitialState(realCashLamports);
    await saveAgenticState(initial);
    return initial;
  }
}

export async function saveAgenticState(state: AgenticState): Promise<void> {
  const next = sanitizeState({
    ...state,
    updatedAt: new Date().toISOString(),
  });

  await ensureStateDir();
  const tempPath = config.runtime.agentic.statePath + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2));
  await fs.rename(tempPath, config.runtime.agentic.statePath);
}
