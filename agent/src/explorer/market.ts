import type { ChainPlugin, MarketData, TokenInfo } from "../chains/types.js";
import { createLogger } from "../utils/logger.js";
import { config } from "../config/index.js";

const log = createLogger("market");

export interface MarketSnapshot {
  timestamp: number;
  markets: MarketData[];
  trending: TokenInfo[];
}

export async function collectMarketData(
  chains: ChainPlugin[]
): Promise<MarketSnapshot> {
  const allMarkets: MarketData[] = [];
  const allTrending: TokenInfo[] = [];

  for (const chain of chains) {
    try {
      const [markets, trending] = await Promise.all([
        chain.getMarketData(),
        chain.getTrendingTokens(),
      ]);

      allMarkets.push(...markets);
      allTrending.push(...trending);

      log.info(`[${chain.name}] ${markets.length} markets, ${trending.length} trending`);
    } catch (e) {
      log.error(`Failed to collect data from ${chain.name}`, e);
    }
  }

  // Filter by minimum liquidity
  const filtered = allMarkets.filter(
    (m) => m.liquidity >= config.risk.minLiquidityUsd
  );

  log.info(`Total: ${filtered.length} markets above $${config.risk.minLiquidityUsd} liquidity`);

  return {
    timestamp: Date.now(),
    markets: filtered,
    trending: allTrending,
  };
}
