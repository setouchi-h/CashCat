import { PublicKey } from "@solana/web3.js";
import type { ChainPlugin, TradeOrder } from "../chains/types.js";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import { PortfolioTracker } from "../portfolio/tracker.js";
import {
  archiveConsumedItem,
  consumeExecutionIntents,
  consumeImprovementProposals,
  prepareRuntimeDirs,
  triggerRuntimeAutoRun,
  writeExecutionResult,
  writeImprovementVerdict,
} from "../runtime/bridge.js";
import type {
  ExecutionIntent,
  ExecutionResult,
  ImprovementProposal,
  ImprovementVerdict,
} from "../runtime/types.js";

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
    await prepareRuntimeDirs();
    this.running = true;
    log.info(
      `Executor started (paper=${config.paperTrade}, interval=${config.scanIntervalSeconds}s)`
    );

    while (this.running) {
      this.cycleCount++;
      log.info(`=== Cycle #${this.cycleCount} ===`);

      try {
        await triggerRuntimeAutoRun(this.cycleCount);
      } catch (e) {
        log.warn("Runtime auto command failed", e);
      }

      let executed = 0;
      let judged = 0;

      try {
        executed = await this.processExecutionIntents();
      } catch (e) {
        log.error("Intent processing error", e);
      }

      try {
        judged = await this.processImprovementProposals();
      } catch (e) {
        log.error("Proposal processing error", e);
      }

      if (executed === 0 && judged === 0) {
        log.info("No intents or proposals in queue");
      }

      if (executed > 0) {
        this.tracker.printSummary();
      }

      if (this.running) {
        const waitMs = config.scanIntervalSeconds * 1000;
        log.info(`Waiting ${config.scanIntervalSeconds}s for next cycle...`);
        await sleep(waitMs);
      }
    }
  }

  stop(): void {
    this.running = false;
    log.info("Executor stopping...");
    this.tracker.printSummary();
  }

  private async processExecutionIntents(): Promise<number> {
    const items = await consumeExecutionIntents(config.runtime.maxIntentsPerCycle);
    if (items.length === 0) return 0;

    log.info(`Loaded ${items.length} execution intents`);

    let processed = 0;
    for (const item of items) {
      const intent = item.payload;
      const result = await this.executeIntent(intent);

      await writeExecutionResult(result);
      await archiveConsumedItem(item.filePath, result.status);
      processed++;
    }

    return processed;
  }

  private async processImprovementProposals(): Promise<number> {
    const items = await consumeImprovementProposals(
      config.runtime.maxProposalsPerCycle
    );
    if (items.length === 0) return 0;

    log.info(`Loaded ${items.length} improvement proposals`);

    let processed = 0;
    for (const item of items) {
      const proposal = item.payload;
      const verdict = judgeProposal(proposal);

      await writeImprovementVerdict(verdict);
      await archiveConsumedItem(item.filePath, verdict.decision);
      log.info(
        `Proposal ${proposal.id} -> ${verdict.decision.toUpperCase()} (${verdict.reason})`
      );
      processed++;
    }

    return processed;
  }

  private async executeIntent(intent: ExecutionIntent): Promise<ExecutionResult> {
    if (config.runtime.killSwitch) {
      return buildRejectedResult(intent, "Global kill switch is enabled");
    }

    const validationError = validateIntent(intent);
    if (validationError) {
      const status = validationError.status ?? "rejected";
      return buildRejectedResult(intent, validationError.reason, status);
    }

    const order: TradeOrder = {
      action: intent.action,
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amountLamports: intent.amountLamports,
      slippageBps: intent.slippageBps,
    };

    const result = await this.chains[0].executeTrade(order);
    const now = new Date().toISOString();

    const executionResult: ExecutionResult = {
      type: "execution-result",
      intentId: intent.id,
      createdAt: now,
      status: result.success ? "filled" : "failed",
      txHash: result.txHash,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      error: result.error,
    };

    this.tracker.recordTrade({
      id: `${intent.id}-${Date.now()}`,
      timestamp: now,
      chain: this.chains[0].name,
      action: intent.action,
      tokenSymbol: inferTokenSymbol(intent),
      tokenAddress: intent.outputMint,
      amountUsd: 0,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      txHash: result.txHash,
      success: result.success,
      reasoning: "External intent execution",
      confidence: 1,
      pnlUsd: result.pnlUsd,
    });

    return executionResult;
  }
}

function buildRejectedResult(
  intent: ExecutionIntent,
  reason: string,
  status: "rejected" | "expired" = "rejected"
): ExecutionResult {
  return {
    type: "execution-result",
    intentId: intent.id,
    createdAt: new Date().toISOString(),
    status,
    inputAmount: String(intent.amountLamports),
    outputAmount: "0",
    reason,
    error: reason,
  };
}

function validateIntent(
  intent: ExecutionIntent
): { reason: string; status?: "expired" | "rejected" } | null {
  if (!isValidMint(intent.inputMint)) {
    return { reason: "inputMint is invalid" };
  }
  if (!isValidMint(intent.outputMint)) {
    return { reason: "outputMint is invalid" };
  }
  if (intent.inputMint === intent.outputMint) {
    return { reason: "inputMint and outputMint must differ" };
  }
  if (!Number.isInteger(intent.amountLamports) || intent.amountLamports <= 0) {
    return { reason: "amountLamports must be a positive integer" };
  }
  if (intent.amountLamports > config.runtime.maxAmountLamports) {
    return {
      reason: `amountLamports exceeds maxAmountLamports (${config.runtime.maxAmountLamports})`,
    };
  }
  if (!Number.isInteger(intent.slippageBps) || intent.slippageBps < 1) {
    return { reason: "slippageBps must be a positive integer" };
  }
  if (intent.slippageBps > config.runtime.maxSlippageBps) {
    return {
      reason: `slippageBps exceeds maxSlippageBps (${config.runtime.maxSlippageBps})`,
    };
  }
  if (
    config.runtime.allowedInputMints.length > 0 &&
    !config.runtime.allowedInputMints.includes(intent.inputMint)
  ) {
    return { reason: "inputMint not in allowedInputMints" };
  }
  if (
    config.runtime.allowedOutputMints.length > 0 &&
    !config.runtime.allowedOutputMints.includes(intent.outputMint)
  ) {
    return { reason: "outputMint not in allowedOutputMints" };
  }
  if (intent.expiresAt) {
    const expiry = Date.parse(intent.expiresAt);
    if (!Number.isFinite(expiry)) {
      return { reason: "expiresAt is invalid" };
    }
    if (Date.now() > expiry) {
      return { reason: "intent expired", status: "expired" };
    }
  }

  return null;
}

function judgeProposal(proposal: ImprovementProposal): ImprovementVerdict {
  const gate = {
    minPnlDeltaPct: config.runtime.gate.minPnlDeltaPct,
    minSharpeDelta: config.runtime.gate.minSharpeDelta,
    maxDrawdownDeltaPct: config.runtime.gate.maxDrawdownDeltaPct,
    minTestPassRate: config.runtime.gate.minTestPassRate,
  };

  let decision: "accept" | "reject" = "accept";
  const reasons: string[] = [];

  if (proposal.metrics.pnlDeltaPct < gate.minPnlDeltaPct) {
    decision = "reject";
    reasons.push(
      `pnlDeltaPct ${proposal.metrics.pnlDeltaPct} < ${gate.minPnlDeltaPct}`
    );
  }
  if (proposal.metrics.sharpeDelta < gate.minSharpeDelta) {
    decision = "reject";
    reasons.push(
      `sharpeDelta ${proposal.metrics.sharpeDelta} < ${gate.minSharpeDelta}`
    );
  }
  if (proposal.metrics.maxDrawdownDeltaPct > gate.maxDrawdownDeltaPct) {
    decision = "reject";
    reasons.push(
      `maxDrawdownDeltaPct ${proposal.metrics.maxDrawdownDeltaPct} > ${gate.maxDrawdownDeltaPct}`
    );
  }
  if (proposal.metrics.testPassRate < gate.minTestPassRate) {
    decision = "reject";
    reasons.push(
      `testPassRate ${proposal.metrics.testPassRate} < ${gate.minTestPassRate}`
    );
  }

  return {
    type: "improvement-verdict",
    proposalId: proposal.id,
    candidateId: proposal.candidateId,
    createdAt: new Date().toISOString(),
    decision,
    reason: reasons.length > 0 ? reasons.join("; ") : "All gates passed",
    metrics: proposal.metrics,
    gate,
  };
}

function inferTokenSymbol(intent: ExecutionIntent): string {
  const meta = intent.metadata;
  if (meta && typeof meta.tokenSymbol === "string" && meta.tokenSymbol.trim()) {
    return meta.tokenSymbol.trim().toUpperCase();
  }
  return intent.outputMint.slice(0, 6);
}

function isValidMint(value: string): boolean {
  if (!value || value.length < 32 || value.length > 44) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
