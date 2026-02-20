import { createLogger } from "../utils/logger.js";

const log = createLogger("portfolio");

export interface TradeRecord {
  id: string;
  timestamp: string;
  chain: string;
  action: "buy" | "sell";
  tokenSymbol: string;
  tokenAddress: string;
  amountUsd: number;
  inputAmount: string;
  outputAmount: string;
  txHash?: string;
  success: boolean;
  reasoning: string;
  confidence: number;
  pnlUsd?: number;
}

export class PortfolioTracker {
  private trades: TradeRecord[] = [];
  private paperBalances: Map<string, number> = new Map();

  recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);

    log.info(
      `[${trade.success ? "OK" : "FAIL"}] ${trade.action.toUpperCase()} ${trade.tokenSymbol}: $${trade.amountUsd.toFixed(2)} | tx: ${trade.txHash ?? "N/A"}`
    );

    if (trade.success) {
      this.updatePaperBalance(trade);
    }
  }

  private updatePaperBalance(trade: TradeRecord): void {
    if (trade.action === "buy") {
      const current = this.paperBalances.get(trade.tokenAddress) ?? 0;
      this.paperBalances.set(
        trade.tokenAddress,
        current + Number(trade.outputAmount)
      );
    } else {
      const current = this.paperBalances.get(trade.tokenAddress) ?? 0;
      this.paperBalances.set(
        trade.tokenAddress,
        Math.max(0, current - Number(trade.inputAmount))
      );
    }
  }

  getRecentTrades(limit = 20): TradeRecord[] {
    return this.trades.slice(-limit);
  }

  getTodaysTrades(): TradeRecord[] {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    return this.trades.filter(
      (t) => new Date(t.timestamp).getTime() >= todayMs
    );
  }

  getTotalPnl(): number {
    return this.trades.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
  }

  getTradeCount(): number {
    return this.trades.length;
  }

  getWinRate(): number {
    const completed = this.trades.filter(
      (t) => t.success && t.pnlUsd !== undefined
    );
    if (completed.length === 0) return 0;
    const wins = completed.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    return wins / completed.length;
  }

  printSummary(): void {
    log.info("=== Portfolio Summary ===");
    log.info(`Total trades: ${this.getTradeCount()}`);
    log.info(`Win rate: ${(this.getWinRate() * 100).toFixed(1)}%`);
    log.info(`Total P&L: $${this.getTotalPnl().toFixed(2)}`);

    if (this.paperBalances.size > 0) {
      log.info("Paper balances:");
      for (const [addr, balance] of this.paperBalances) {
        log.info(`  ${addr.slice(0, 8)}...: ${balance}`);
      }
    }
  }
}
