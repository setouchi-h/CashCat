import type {
  ChainPlugin,
  MarketData,
  TokenInfo,
  PortfolioBalance,
  TradeOrder,
  TradeResult,
  SwapParams,
  SwapQuote,
} from "../types.js";
import { getPortfolioBalance } from "./data.js";
import { getJupiterQuote, executeSwap } from "./swap.js";
import { fetchDexScreenerSolana } from "../../explorer/dexscreener.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("solana");

export class SolanaPlugin implements ChainPlugin {
  name = "solana";

  async getMarketData(): Promise<MarketData[]> {
    log.info("Fetching market data...");
    return fetchDexScreenerSolana();
  }

  async getTrendingTokens(): Promise<TokenInfo[]> {
    const markets = await this.getMarketData();
    return markets
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 20)
      .map((m) => m.token);
  }

  async getBalance(): Promise<PortfolioBalance> {
    return getPortfolioBalance();
  }

  async executeTrade(trade: TradeOrder): Promise<TradeResult> {
    return executeSwap(trade);
  }

  async getSwapQuote(params: SwapParams): Promise<SwapQuote> {
    return getJupiterQuote(params);
  }
}
