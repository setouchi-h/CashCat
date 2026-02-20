import type { ChainPlugin, TradeOrder, TradeResult } from "../types.js";
import { executeSwap } from "./swap.js";
import { config } from "../../config/index.js";
import { PaperPortfolio } from "./paper.js";
import { SOL_MINT } from "./wallet.js";

export class SolanaPlugin implements ChainPlugin {
  name = "solana";
  private paper = new PaperPortfolio();

  async executeTrade(trade: TradeOrder): Promise<TradeResult> {
    if (config.paperTrade) {
      const allowed = this.validatePaperTrade(trade);
      if (!allowed.ok) {
        return {
          success: false,
          inputAmount: String(trade.amountLamports),
          outputAmount: "0",
          error: allowed.reason,
        };
      }
    }

    const result = await executeSwap(trade);

    if (config.paperTrade && result.success) {
      const pnlUsd = await this.paper.applyTrade(trade, result);
      if (typeof pnlUsd === "number") {
        result.pnlUsd = pnlUsd;
      }
    }

    return result;
  }

  private validatePaperTrade(
    trade: TradeOrder
  ): { ok: true } | { ok: false; reason: string } {
    if (trade.action === "buy" && trade.inputMint === SOL_MINT) {
      const solLamports = this.paper.getSolLamports();
      const need = BigInt(trade.amountLamports);
      if (need > solLamports) {
        return {
          ok: false,
          reason: `Insufficient paper SOL balance (${solLamports} < ${need})`,
        };
      }
      return { ok: true };
    }

    if (trade.action === "sell") {
      const held = this.paper.getTokenRawBalance(trade.inputMint);
      const need = BigInt(trade.amountLamports);
      if (need > held) {
        return {
          ok: false,
          reason: `Insufficient paper token balance (${held} < ${need})`,
        };
      }
      return { ok: true };
    }

    return { ok: true };
  }
}
