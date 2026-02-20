import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import type { TradeDecision } from "../brain/prompts.js";
import type { PortfolioBalance, MarketData } from "../chains/types.js";
import type { TradeRecord } from "../portfolio/tracker.js";

const log = createLogger("risk");

export interface RiskCheckResult {
  approved: boolean;
  reason: string;
  adjustedAmountPct?: number;
}

export function checkTradeRisk(
  decision: TradeDecision,
  portfolio: PortfolioBalance,
  markets: MarketData[],
  todaysTrades: TradeRecord[]
): RiskCheckResult {
  const { risk } = config;

  // 1. Confidence threshold
  if (decision.confidence < risk.minConfidence) {
    return {
      approved: false,
      reason: `Confidence ${decision.confidence} below threshold ${risk.minConfidence}`,
    };
  }

  // 2. Max trade size
  if (decision.amount_pct > risk.maxTradePercent) {
    log.warn(`Trade size ${decision.amount_pct}% exceeds max ${risk.maxTradePercent}%, capping`);
    decision.amount_pct = risk.maxTradePercent;
  }

  // 3. Daily loss limit
  const todaysLoss = todaysTrades
    .filter((t) => t.pnlUsd !== undefined && t.pnlUsd < 0)
    .reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);

  const lossLimitUsd = portfolio.totalValueUsd * (risk.dailyLossLimitPercent / 100);
  if (Math.abs(todaysLoss) >= lossLimitUsd) {
    return {
      approved: false,
      reason: `Daily loss limit reached: $${Math.abs(todaysLoss).toFixed(2)} >= $${lossLimitUsd.toFixed(2)}`,
    };
  }

  // 4. Max positions (for buys)
  if (decision.action === "buy") {
    const currentPositions = portfolio.tokens.filter((t) => t.valueUsd > 1).length;
    if (currentPositions >= risk.maxPositions) {
      return {
        approved: false,
        reason: `Max positions reached: ${currentPositions}/${risk.maxPositions}`,
      };
    }
  }

  // 5. Liquidity check
  if (decision.action === "buy") {
    const market = markets.find(
      (m) =>
        m.token.address === decision.tokenAddress ||
        m.token.symbol === decision.token
    );

    if (market && market.liquidity < risk.minLiquidityUsd) {
      return {
        approved: false,
        reason: `Liquidity $${market.liquidity.toFixed(0)} below minimum $${risk.minLiquidityUsd}`,
      };
    }
  }

  // 6. Minimum trade value ($1 to avoid dust trades)
  const tradeValueUsd = portfolio.totalValueUsd * (decision.amount_pct / 100);
  if (tradeValueUsd < 1) {
    return {
      approved: false,
      reason: `Trade value $${tradeValueUsd.toFixed(2)} too small`,
    };
  }

  log.info(`Trade approved: ${decision.action} ${decision.token} ${decision.amount_pct}% (confidence: ${decision.confidence})`);

  return {
    approved: true,
    reason: "All risk checks passed",
    adjustedAmountPct: decision.amount_pct,
  };
}
