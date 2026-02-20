import type { MarketSnapshot } from "../explorer/market.js";
import type { PortfolioBalance } from "../chains/types.js";
import type { TradeRecord } from "../portfolio/tracker.js";

export interface TradeDecision {
  action: "buy" | "sell" | "hold";
  token: string;
  tokenAddress: string;
  amount_pct: number;
  reasoning: string;
  confidence: number;
}

export interface AnalysisResult {
  decisions: TradeDecision[];
  marketSummary: string;
}

export function buildAnalysisPrompt(
  snapshot: MarketSnapshot,
  portfolio: PortfolioBalance,
  recentTrades: TradeRecord[]
): string {
  const topMarkets = snapshot.markets
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 30);

  const marketsText = topMarkets
    .map(
      (m) =>
        `${m.token.symbol} (${m.token.address.slice(0, 8)}...): $${m.priceUsd.toFixed(6)} | Vol24h: $${fmtNum(m.volume24h)} | Liq: $${fmtNum(m.liquidity)} | 5m: ${m.priceChange5m?.toFixed(1)}% | 1h: ${m.priceChange1h?.toFixed(1)}% | 24h: ${m.priceChange24h?.toFixed(1)}% | Buys/Sells: ${m.txns24h.buys}/${m.txns24h.sells}`
    )
    .join("\n");

  const portfolioText = [
    `SOL: ${portfolio.nativeBalance.toFixed(4)} ($${portfolio.nativeValueUsd.toFixed(2)})`,
    ...portfolio.tokens.map(
      (t) => `${t.symbol} (${t.address.slice(0, 8)}...): ${t.balance} ($${t.valueUsd.toFixed(2)})`
    ),
    `Total: $${portfolio.totalValueUsd.toFixed(2)}`,
  ].join("\n");

  const tradesText =
    recentTrades.length > 0
      ? recentTrades
          .slice(-10)
          .map(
            (t) =>
              `${t.timestamp} ${t.action} ${t.tokenSymbol}: $${t.amountUsd.toFixed(2)} -> ${t.success ? "OK" : "FAIL"} (${t.reasoning.slice(0, 50)})`
          )
          .join("\n")
      : "No recent trades";

  return `You are an autonomous crypto trading agent analyzing the Solana market.

## Current Portfolio
${portfolioText}

## Top Markets (by 24h volume)
${marketsText}

## Recent Trades
${tradesText}

## Task
Analyze the market data and decide which trades to make. Consider:
1. Price momentum (5m, 1h, 24h changes)
2. Volume relative to liquidity (high volume/liquidity ratio = strong interest)
3. Buy/sell ratio in transactions
4. Current portfolio allocation
5. Risk management (don't overconcentrate)

Return your analysis as JSON with this exact format:
{
  "decisions": [
    {
      "action": "buy" | "sell" | "hold",
      "token": "SYMBOL",
      "tokenAddress": "full_address",
      "amount_pct": <1-5>,
      "reasoning": "brief explanation",
      "confidence": <0.0-1.0>
    }
  ],
  "marketSummary": "1-2 sentence market overview"
}

Rules:
- Only suggest trades with confidence >= 0.7
- amount_pct is the % of total portfolio value to use (max 5%)
- For sells, amount_pct is the % of that token's holdings to sell
- Include a "hold" decision if no good opportunities exist
- Maximum 3 trade decisions per cycle
- Prefer tokens with liquidity > $50,000
- Be skeptical of extreme price movements (potential pump & dump)`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}
