import type { ChainPlugin, TradeOrder, TradeResult } from "../types.js";

export class SolanaPlugin implements ChainPlugin {
  name = "solana";

  async executeTrade(_trade: TradeOrder): Promise<TradeResult> {
    throw new Error(
      "Direct chain execution is disabled. All trades must go through wallet-mcp."
    );
  }
}
