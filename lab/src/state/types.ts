import type { ImprovementProposal } from "../runtime/types.js";

export interface LabPolicy {
  buyMomentumThreshold: number;
  sellMomentumThreshold: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  tradeAllocationPct: number;
  minTradeSol: number;
  maxTradeSol: number;
  maxOpenPositions: number;
  sellFraction: number;
  intentSlippageBps: number;
}

export interface PositionState {
  mint: string;
  symbol: string;
  decimals: number;
  rawAmount: string;
  costLamports: string;
  openedAt: string;
  updatedAt: string;
}

export interface IssuedIntentRecord {
  id: string;
  createdAt: string;
  action: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  symbol: string;
  amountLamports: number;
  slippageBps: number;
}

export interface PendingCandidate {
  id: string;
  createdAt: string;
  policy: LabPolicy;
  proposalPreview: ImprovementProposal;
}

export interface LabState {
  cycle: number;
  cashLamports: string;
  realizedPnlLamports: string;
  closedTradePnlsLamports: string[];
  equityCurveLamports: string[];
  positions: Record<string, PositionState>;
  issuedIntents: Record<string, IssuedIntentRecord>;
  processedResultFiles: string[];
  processedVerdictFiles: string[];
  marketHistory: Record<string, { ts: number; priceUsd: number }[]>;
  lastIntentAt: Record<string, number>;
  policy: LabPolicy;
  pendingCandidates: Record<string, PendingCandidate>;
  filledCount: number;
  failedCount: number;
  updatedAt: string;
}
