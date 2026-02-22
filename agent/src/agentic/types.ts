import type { ExecutionIntent } from "../runtime/types.js";

export interface AgenticPosition {
  mint: string;
  symbol: string;
  decimals: number;
  rawAmount: string;
  costLamports: string;
  openedAt: string;
  updatedAt: string;
}

export interface AgenticState {
  cycle: number;
  cashLamports: string;
  initialCashLamports?: string;
  realizedPnlLamports: string;
  positions: Record<string, AgenticPosition>;
  marketHistory: Record<string, { ts: number; priceUsd: number }[]>;
  lastIntentAt: Record<string, number>;
  filledCount: number;
  failedCount: number;
  updatedAt: string;
}

export interface PlannedIntents {
  intents: ExecutionIntent[];
  notes: string[];
}

export interface SignalPoint {
  ts: number;
  priceUsd: number;
}

export interface MomentumSignal {
  score: number;
  momentum1m: number;
  momentum5m: number;
  volatility: number;
}
