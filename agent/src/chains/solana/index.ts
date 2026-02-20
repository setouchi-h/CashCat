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
import { getPortfolioBalance, getSolPriceUsd } from "./data.js";
import { getJupiterQuote, executeSwap } from "./swap.js";
import { fetchDexScreenerSolana } from "../../explorer/dexscreener.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("solana");

const PAPER_INITIAL_SOL = 10;

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
    if (config.paperTrade && !config.solana.privateKey) {
      const solPrice = await getSolPriceUsd();
      const solValueUsd = PAPER_INITIAL_SOL * solPrice;
      log.info(`[PAPER] Portfolio: ${PAPER_INITIAL_SOL} SOL ($${solValueUsd.toFixed(2)})`);
      return {
        nativeBalance: PAPER_INITIAL_SOL,
        nativeValueUsd: solValueUsd,
        tokens: [],
        totalValueUsd: solValueUsd,
      };
    }
    return getPortfolioBalance();
  }

  async executeTrade(trade: TradeOrder): Promise<TradeResult> {
    return executeSwap(trade);
  }

  async getSwapQuote(params: SwapParams): Promise<SwapQuote> {
    return getJupiterQuote(params);
  }
}
