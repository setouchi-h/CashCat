import { config } from "../config/index.js";
import type { LabPolicy, LabState } from "../state/types.js";
import { computeMomentumSignal } from "../strategy/signal.js";

export interface PolicyMetrics {
  pnlPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  trades: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function calculateSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, v) => sum + v, 0) / returns.length;
  const variance =
    returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / returns.length;
  if (variance <= 0) return 0;
  return (mean / Math.sqrt(variance)) * Math.sqrt(returns.length);
}

function calculateMaxDrawdownPct(equity: number[]): number {
  if (equity.length === 0) return 0;
  let peak = equity[0];
  let maxDrawdown = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    if (peak <= 0) continue;
    const drawdown = (peak - value) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

function simulateToken(
  policy: LabPolicy,
  history: { ts: number; priceUsd: number }[]
): PolicyMetrics & { returns: number[] } {
  if (history.length < config.improve.minHistoryPointsForEvaluation) {
    return {
      pnlPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      trades: 0,
      returns: [],
    };
  }

  let equity = 1;
  let inPosition = false;
  let entryPrice = 0;
  const equitySeries: number[] = [equity];
  const returns: number[] = [];

  for (let i = 0; i < history.length; i++) {
    const current = history[i];
    const window = history.slice(0, i + 1);
    const signal = computeMomentumSignal(window, current.ts);

    if (!inPosition && signal.score >= policy.buyMomentumThreshold) {
      inPosition = true;
      entryPrice = current.priceUsd;
    }

    if (inPosition && entryPrice > 0) {
      const pnlPct = current.priceUsd / entryPrice - 1;
      const shouldExit =
        signal.score <= policy.sellMomentumThreshold ||
        pnlPct >= policy.takeProfitPct ||
        pnlPct <= policy.stopLossPct;

      if (shouldExit) {
        equity *= current.priceUsd / entryPrice;
        returns.push(current.priceUsd / entryPrice - 1);
        inPosition = false;
        entryPrice = 0;
      }
    }

    const markToMarket =
      inPosition && entryPrice > 0 ? equity * (current.priceUsd / entryPrice) : equity;
    equitySeries.push(markToMarket);
  }

  if (inPosition && entryPrice > 0) {
    const lastPrice = history.at(-1)?.priceUsd ?? entryPrice;
    equity *= lastPrice / entryPrice;
    returns.push(lastPrice / entryPrice - 1);
    equitySeries.push(equity);
  }

  return {
    pnlPct: clamp(equity - 1, -1, 10),
    sharpe: calculateSharpe(returns),
    maxDrawdownPct: clamp(calculateMaxDrawdownPct(equitySeries), 0, 1),
    trades: returns.length,
    returns,
  };
}

export function simulatePolicy(policy: LabPolicy, state: LabState): PolicyMetrics {
  const tokenHistories = config.market.tokenUniverse
    .map((token) => state.marketHistory[token.mint] ?? [])
    .filter((history) => history.length >= config.improve.minHistoryPointsForEvaluation);

  if (tokenHistories.length === 0) {
    return {
      pnlPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      trades: 0,
    };
  }

  const perToken = tokenHistories.map((history) => simulateToken(policy, history));
  const pnlPct =
    perToken.reduce((sum, m) => sum + m.pnlPct, 0) / Math.max(1, perToken.length);

  const allReturns = perToken.flatMap((m) => m.returns);
  const sharpe = calculateSharpe(allReturns);
  const maxDrawdownPct = Math.max(...perToken.map((m) => m.maxDrawdownPct));
  const trades = perToken.reduce((sum, m) => sum + m.trades, 0);

  return {
    pnlPct,
    sharpe,
    maxDrawdownPct,
    trades,
  };
}
