import { config } from "../config/index.js";
import type { ImprovementProposal } from "../runtime/types.js";
import type { LabPolicy, LabState, PendingCandidate } from "../state/types.js";
import type { PolicyMetrics } from "./simulator.js";

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function mutate(value: number, scale: number): number {
  const r = (Math.random() * 2 - 1) * scale;
  return value * (1 + r);
}

export function mutatePolicy(base: LabPolicy): LabPolicy {
  const mutated: LabPolicy = {
    buyMomentumThreshold: clamp(
      mutate(base.buyMomentumThreshold, config.improve.policyMutationScale),
      0.001,
      0.03
    ),
    sellMomentumThreshold: clamp(
      mutate(base.sellMomentumThreshold, config.improve.policyMutationScale),
      -0.03,
      -0.0005
    ),
    takeProfitPct: clamp(
      mutate(base.takeProfitPct, config.improve.policyMutationScale),
      0.01,
      0.25
    ),
    stopLossPct: clamp(
      mutate(base.stopLossPct, config.improve.policyMutationScale),
      -0.25,
      -0.01
    ),
    maxHoldMinutes: Math.floor(
      clamp(mutate(base.maxHoldMinutes, config.improve.policyMutationScale), 30, 1440)
    ),
    tradeAllocationPct: clamp(
      mutate(base.tradeAllocationPct, config.improve.policyMutationScale),
      0.01,
      0.4
    ),
    minTradeSol: clamp(
      mutate(base.minTradeSol, config.improve.policyMutationScale),
      0.01,
      5
    ),
    maxTradeSol: clamp(
      mutate(base.maxTradeSol, config.improve.policyMutationScale),
      0.05,
      10
    ),
    maxOpenPositions: Math.floor(
      clamp(mutate(base.maxOpenPositions, config.improve.policyMutationScale), 1, 10)
    ),
    sellFraction: clamp(
      mutate(base.sellFraction, config.improve.policyMutationScale),
      0.25,
      1
    ),
    intentSlippageBps: Math.floor(
      clamp(mutate(base.intentSlippageBps, config.improve.policyMutationScale), 30, 500)
    ),
  };

  if (mutated.maxTradeSol < mutated.minTradeSol) {
    mutated.maxTradeSol = mutated.minTradeSol;
  }

  return mutated;
}

function calcTestPassRate(state: LabState): number {
  const total = state.filledCount + state.failedCount;
  if (total <= 0) return 1;
  return state.filledCount / total;
}

export function buildProposal(
  state: LabState,
  candidatePolicy: LabPolicy,
  currentMetrics: PolicyMetrics,
  candidateMetrics: PolicyMetrics,
  now: Date
): { proposal: ImprovementProposal; pending: PendingCandidate } {
  const candidateId = `candidate-${now.getTime()}-${Math.floor(Math.random() * 1_000_000)
    .toString(36)
    .padStart(4, "0")}`;
  const proposalId = `proposal-${candidateId}`;

  const proposal: ImprovementProposal = {
    type: "improvement-proposal",
    id: proposalId,
    createdAt: now.toISOString(),
    candidateId,
    metrics: {
      pnlDeltaPct: candidateMetrics.pnlPct - currentMetrics.pnlPct,
      sharpeDelta: candidateMetrics.sharpe - currentMetrics.sharpe,
      maxDrawdownDeltaPct:
        candidateMetrics.maxDrawdownPct - currentMetrics.maxDrawdownPct,
      testPassRate: calcTestPassRate(state),
    },
    artifacts: {
      reportRef: `${config.state.dir}/candidate-${candidateId}.json`,
      patchRef: "policy-only",
    },
    notes:
      `current={pnl:${currentMetrics.pnlPct.toFixed(4)},sharpe:${currentMetrics.sharpe.toFixed(
        4
      )},dd:${currentMetrics.maxDrawdownPct.toFixed(4)}} ` +
      `candidate={pnl:${candidateMetrics.pnlPct.toFixed(4)},sharpe:${candidateMetrics.sharpe.toFixed(
        4
      )},dd:${candidateMetrics.maxDrawdownPct.toFixed(4)}}`,
  };

  const pending: PendingCandidate = {
    id: candidateId,
    createdAt: now.toISOString(),
    policy: candidatePolicy,
    proposalPreview: proposal,
  };

  return {
    proposal,
    pending,
  };
}
