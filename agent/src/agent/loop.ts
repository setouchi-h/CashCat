import type { ChainPlugin } from "../chains/types.js";
import { collectMarketData } from "../explorer/market.js";
import { analyzeMarket } from "../brain/analyzer.js";
import { checkTradeRisk } from "../risk/guard.js";
import { PortfolioTracker } from "../portfolio/tracker.js";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import { SOL_MINT } from "../chains/solana/wallet.js";

const log = createLogger("agent");

export class AgentLoop {
  private chains: ChainPlugin[];
  private tracker: PortfolioTracker;
  private running = false;
  private cycleCount = 0;

  constructor(chains: ChainPlugin[]) {
    this.chains = chains;
    this.tracker = new PortfolioTracker();
  }

  async start(): Promise<void> {
    this.running = true;
    log.info(`Agent started (paper=${config.paperTrade}, interval=${config.scanIntervalMinutes}m)`);

    while (this.running) {
      try {
        await this.runCycle();
      } catch (e) {
        log.error("Cycle error", e);
      }

      if (this.running) {
        const waitMs = config.scanIntervalMinutes * 60 * 1000;
        log.info(`Waiting ${config.scanIntervalMinutes}m for next cycle...`);
        await sleep(waitMs);
      }
    }
  }

  stop(): void {
    this.running = false;
    log.info("Agent stopping...");
    this.tracker.printSummary();
  }

  private async runCycle(): Promise<void> {
    this.cycleCount++;
    log.info(`=== Cycle #${this.cycleCount} ===`);

    // 1. EXPLORE: Collect market data
    log.info("Step 1: Collecting market data...");
    const snapshot = await collectMarketData(this.chains);

    if (snapshot.markets.length === 0) {
      log.warn("No market data available, skipping cycle");
      return;
    }

    // 2. Get portfolio balance
    log.info("Step 2: Fetching portfolio...");
    let portfolio = await this.chains[0].getBalance();

    // 3. ANALYZE: Send to configured LLM
    log.info("Step 3: Analyzing with LLM...");
    const analysis = await analyzeMarket(
      snapshot,
      portfolio,
      this.tracker.getRecentTrades()
    );

    log.info(`Market summary: ${analysis.marketSummary}`);
    log.info(`Decisions: ${analysis.decisions.length}`);

    // 4. VALIDATE & EXECUTE each decision
    for (const decision of analysis.decisions) {
      if (decision.action === "hold") {
        log.info(`Hold: ${decision.reasoning}`);
        continue;
      }

      log.info(`Evaluating: ${decision.action} ${decision.token} (${decision.amount_pct}%, confidence: ${decision.confidence})`);

      // Risk check
      const riskResult = checkTradeRisk(
        decision,
        portfolio,
        snapshot.markets,
        this.tracker.getTodaysTrades()
      );

      if (!riskResult.approved) {
        log.warn(`Rejected: ${riskResult.reason}`);
        continue;
      }

      // Calculate trade amounts
      const amountPct = riskResult.adjustedAmountPct ?? decision.amount_pct;
      const tradeValueUsd = portfolio.totalValueUsd * (amountPct / 100);

      // Determine input/output mints
      const inputMint =
        decision.action === "buy" ? SOL_MINT : decision.tokenAddress;
      const outputMint =
        decision.action === "buy" ? decision.tokenAddress : SOL_MINT;

      // Convert to lamports (approximate)
      const solPrice =
        portfolio.nativeBalance > 0
          ? portfolio.nativeValueUsd / portfolio.nativeBalance
          : 0;
      const amountLamports =
        decision.action === "buy"
          ? Math.floor((tradeValueUsd / solPrice) * 1e9)
          : 0; // For sells, need token-specific calculation

      if (amountLamports <= 0) {
        log.warn("Could not calculate trade amount, skipping");
        continue;
      }

      // Execute
      log.info(`Executing: ${decision.action} ${decision.token} for ~$${tradeValueUsd.toFixed(2)}`);

      const result = await this.chains[0].executeTrade({
        action: decision.action,
        inputMint,
        outputMint,
        amountLamports,
        slippageBps: config.risk.maxSlippageBps,
      });

      // 5. TRACK: Record result
      this.tracker.recordTrade({
        id: `${this.cycleCount}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        chain: this.chains[0].name,
        action: decision.action,
        tokenSymbol: decision.token,
        tokenAddress: decision.tokenAddress,
        amountUsd: tradeValueUsd,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        txHash: result.txHash,
        success: result.success,
        reasoning: decision.reasoning,
        confidence: decision.confidence,
      });
    }

    this.tracker.printSummary();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
