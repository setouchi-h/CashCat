import { promises as fs } from "node:fs";
import path from "node:path";
import { SOL_MINT, config, findTokenByMint } from "./config/index.js";
import { buildProposal, mutatePolicy } from "./evaluator/improver.js";
import { simulatePolicy } from "./evaluator/simulator.js";
import { fetchPricesUsd } from "./market/jupiter.js";
import {
  ensureRuntimeDirs,
  readExecutionResults,
  readVerdicts,
  writeIntent,
  writeProposal,
} from "./runtime/io.js";
import type { ExecutionResult, ImprovementVerdict } from "./runtime/types.js";
import { loadState, saveState } from "./state/store.js";
import type { IssuedIntentRecord, LabState, PositionState } from "./state/types.js";
import { buildIntents } from "./strategy/engine.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("lab");

let running = true;

process.on("SIGINT", () => {
  running = false;
  log.info("Received SIGINT, stopping Lab loop");
});

process.on("SIGTERM", () => {
  running = false;
  log.info("Received SIGTERM, stopping Lab loop");
});

function toBigint(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pushRecentUnique(target: string[], value: string, max = 6000): void {
  if (!value) return;
  if (target.includes(value)) return;
  target.push(value);
  if (target.length > max) {
    target.splice(0, target.length - max);
  }
}

function appendMarketHistory(state: LabState, prices: Record<string, number>, nowMs: number): void {
  for (const [mint, price] of Object.entries(prices)) {
    if (!Number.isFinite(price) || price <= 0) continue;
    const history = state.marketHistory[mint] ?? [];
    history.push({ ts: nowMs, priceUsd: price });
    if (history.length > config.market.historyKeepPoints) {
      history.splice(0, history.length - config.market.historyKeepPoints);
    }
    state.marketHistory[mint] = history;
  }
}

function registerIssuedIntent(state: LabState, intent: {
  id: string;
  createdAt: string;
  action: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
  metadata?: Record<string, unknown>;
}): void {
  const symbol =
    typeof intent.metadata?.tokenSymbol === "string" && intent.metadata.tokenSymbol
      ? intent.metadata.tokenSymbol
      : findTokenByMint(intent.outputMint)?.symbol ?? intent.outputMint.slice(0, 6);

  const record: IssuedIntentRecord = {
    id: intent.id,
    createdAt: intent.createdAt,
    action: intent.action,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    symbol,
    amountLamports: intent.amountLamports,
    slippageBps: intent.slippageBps,
  };

  state.issuedIntents[intent.id] = record;
}

function updatePositionForBuy(state: LabState, record: IssuedIntentRecord, result: ExecutionResult): void {
  const inLamports = toBigint(result.inputAmount);
  const outRaw = toBigint(result.outputAmount);
  if (outRaw <= 0n || inLamports <= 0n) return;

  const token = findTokenByMint(record.outputMint);
  const existing = state.positions[record.outputMint];
  const now = nowIso();
  const next: PositionState = existing
    ? {
        ...existing,
        rawAmount: (toBigint(existing.rawAmount) + outRaw).toString(),
        costLamports: (toBigint(existing.costLamports) + inLamports).toString(),
        updatedAt: now,
      }
    : {
        mint: record.outputMint,
        symbol: record.symbol,
        decimals: token?.decimals ?? 0,
        rawAmount: outRaw.toString(),
        costLamports: inLamports.toString(),
        openedAt: now,
        updatedAt: now,
      };

  state.positions[record.outputMint] = next;

  const currentCash = toBigint(state.cashLamports);
  const nextCash = currentCash > inLamports ? currentCash - inLamports : 0n;
  state.cashLamports = nextCash.toString();
}

function updatePositionForSell(state: LabState, record: IssuedIntentRecord, result: ExecutionResult): void {
  const soldRawRequested = toBigint(result.inputAmount);
  const outLamports = toBigint(result.outputAmount);
  if (soldRawRequested <= 0n || outLamports <= 0n) return;

  const position = state.positions[record.inputMint];
  if (!position) {
    state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
    return;
  }

  const rawAmount = toBigint(position.rawAmount);
  const costLamports = toBigint(position.costLamports);
  if (rawAmount <= 0n) {
    delete state.positions[record.inputMint];
    state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
    return;
  }

  const soldRaw = minBigint(rawAmount, soldRawRequested);
  const allocatedCost = (costLamports * soldRaw) / rawAmount;
  const pnlLamports = outLamports - allocatedCost;

  const remainingRaw = rawAmount - soldRaw;
  const remainingCost = costLamports - allocatedCost;

  if (remainingRaw <= 0n) {
    delete state.positions[record.inputMint];
  } else {
    state.positions[record.inputMint] = {
      ...position,
      rawAmount: remainingRaw.toString(),
      costLamports: remainingCost.toString(),
      updatedAt: nowIso(),
    };
  }

  state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
  state.realizedPnlLamports = (toBigint(state.realizedPnlLamports) + pnlLamports).toString();
  state.closedTradePnlsLamports.push(pnlLamports.toString());
  if (state.closedTradePnlsLamports.length > 2000) {
    state.closedTradePnlsLamports.splice(0, state.closedTradePnlsLamports.length - 2000);
  }

  const initialCashLamports = BigInt(Math.floor(config.accounting.initialCashSol * 1_000_000_000));
  const realized = toBigint(state.realizedPnlLamports);
  state.equityCurveLamports.push((initialCashLamports + realized).toString());
  if (state.equityCurveLamports.length > 2000) {
    state.equityCurveLamports.splice(0, state.equityCurveLamports.length - 2000);
  }
}

function applyResult(state: LabState, result: ExecutionResult): string {
  const record = state.issuedIntents[result.intentId];

  if (!record) {
    return `Result ${result.intentId} skipped (intent record not found)`;
  }

  delete state.issuedIntents[result.intentId];

  if (result.status !== "filled") {
    state.failedCount++;
    return `Result ${result.intentId} ${result.status.toUpperCase()} (${result.error ?? result.reason ?? "no reason"})`;
  }

  state.filledCount++;
  if (record.action === "buy") {
    updatePositionForBuy(state, record, result);
    return `BUY filled ${record.symbol} in=${result.inputAmount} out=${result.outputAmount}`;
  }

  updatePositionForSell(state, record, result);
  return `SELL filled ${record.symbol} in=${result.inputAmount} out=${result.outputAmount}`;
}

function applyVerdict(state: LabState, verdict: ImprovementVerdict): string {
  const pending = state.pendingCandidates[verdict.candidateId];
  if (!pending) {
    return `Verdict ${verdict.candidateId} ignored (candidate not found)`;
  }

  if (verdict.decision === "accept") {
    state.policy = pending.policy;
    delete state.pendingCandidates[verdict.candidateId];
    return `Verdict ACCEPT -> policy updated to ${verdict.candidateId}`;
  }

  delete state.pendingCandidates[verdict.candidateId];
  return `Verdict REJECT -> candidate dropped ${verdict.candidateId}`;
}

async function processResults(state: LabState): Promise<string[]> {
  const seen = new Set(state.processedResultFiles);
  const items = await readExecutionResults(seen);

  const logs: string[] = [];
  for (const item of items) {
    pushRecentUnique(state.processedResultFiles, item.name);
    logs.push(applyResult(state, item.payload));
  }

  return logs;
}

async function processVerdicts(state: LabState): Promise<string[]> {
  const seen = new Set(state.processedVerdictFiles);
  const items = await readVerdicts(seen);

  const logs: string[] = [];
  for (const item of items) {
    pushRecentUnique(state.processedVerdictFiles, item.name);
    logs.push(applyVerdict(state, item.payload));
  }

  return logs;
}

function prunePendingCandidates(state: LabState): void {
  const ids = Object.keys(state.pendingCandidates)
    .map((id) => ({ id, createdAt: Date.parse(state.pendingCandidates[id].createdAt) || 0 }))
    .sort((a, b) => a.createdAt - b.createdAt);

  if (ids.length <= config.improve.maxPendingCandidates) return;
  const removeCount = ids.length - config.improve.maxPendingCandidates;
  for (let i = 0; i < removeCount; i++) {
    delete state.pendingCandidates[ids[i].id];
  }
}

async function maybeEmitProposal(state: LabState, now: Date): Promise<string | null> {
  if (!config.improve.enabled) return null;
  if (state.cycle % config.improve.proposalEveryCycles !== 0) return null;
  if (state.closedTradePnlsLamports.length < config.improve.minClosedTradesForProposal) {
    return null;
  }

  prunePendingCandidates(state);
  if (Object.keys(state.pendingCandidates).length >= config.improve.maxPendingCandidates) {
    return null;
  }

  const currentMetrics = simulatePolicy(state.policy, state);
  const candidatePolicy = mutatePolicy(state.policy);
  const candidateMetrics = simulatePolicy(candidatePolicy, state);

  const { proposal, pending } = buildProposal(
    state,
    candidatePolicy,
    currentMetrics,
    candidateMetrics,
    now
  );

  await writeProposal(proposal);

  const candidateReportPath = path.join(config.state.dir, `candidate-${pending.id}.json`);
  await fs.writeFile(
    candidateReportPath,
    JSON.stringify(
      {
        createdAt: now.toISOString(),
        currentPolicy: state.policy,
        candidatePolicy,
        currentMetrics,
        candidateMetrics,
        proposal,
      },
      null,
      2
    )
  );

  state.pendingCandidates[pending.id] = pending;
  prunePendingCandidates(state);

  return `Proposal emitted ${proposal.id} (candidate=${pending.id})`;
}

async function runCycle(state: LabState): Promise<void> {
  const now = new Date();
  const nowMs = now.getTime();
  state.cycle += 1;

  const tokenMints = [SOL_MINT, ...config.market.tokenUniverse.map((t) => t.mint)];
  let prices: Record<string, number> = {};
  try {
    prices = await fetchPricesUsd(tokenMints);
    appendMarketHistory(state, prices, nowMs);
  } catch (e) {
    log.warn(`Price fetch failed; continuing with stored history: ${String(e)}`);
  }

  const resultLogs = await processResults(state);
  const verdictLogs = await processVerdicts(state);

  const { intents, notes } = buildIntents(state, now);
  for (const intent of intents) {
    await writeIntent(intent);
    registerIssuedIntent(state, intent);
  }

  const proposalLog = await maybeEmitProposal(state, now);

  log.info(`Cycle #${state.cycle} complete: intents=${intents.length}, results=${resultLogs.length}, verdicts=${verdictLogs.length}`);
  for (const line of notes) log.info(`[Signal] ${line}`);
  for (const line of resultLogs) log.info(`[Result] ${line}`);
  for (const line of verdictLogs) log.info(`[Verdict] ${line}`);
  if (proposalLog) log.info(`[Improve] ${proposalLog}`);

  const cashSol = Number(toBigint(state.cashLamports)) / 1_000_000_000;
  const realizedSol = Number(toBigint(state.realizedPnlLamports)) / 1_000_000_000;
  log.info(
    `State: cash=${cashSol.toFixed(4)} SOL, realized=${realizedSol.toFixed(4)} SOL, positions=${Object.keys(state.positions).length}, pendingCandidates=${Object.keys(state.pendingCandidates).length}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const once = process.argv.includes("--once") || config.loop.runOnce;

  log.info("CashCat Lab starting...");
  log.info(`Mode: ${once ? "SINGLE CYCLE" : "DAEMON"}`);
  log.info(
    `Runtime queue: intents=${config.runtime.intentDir}, results=${config.runtime.resultDir}, proposals=${config.runtime.proposalDir}, verdicts=${config.runtime.verdictDir}`
  );
  log.info(
    `Universe: ${config.market.tokenUniverse.map((t) => t.symbol).join(", ")}`
  );

  await ensureRuntimeDirs();
  const state = await loadState();

  if (once) {
    await runCycle(state);
    await saveState(state);
    return;
  }

  while (running) {
    try {
      await runCycle(state);
      await saveState(state);
    } catch (e) {
      log.error("Cycle failed", e);
    }

    if (!running) break;
    await sleep(config.loop.intervalSeconds * 1000);
  }

  await saveState(state);
  log.info("CashCat Lab stopped.");
}

main().catch((e) => {
  log.error("Fatal error", e);
  process.exit(1);
});
