import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { loadState, saveState, applyResult, getSummary } from "./state.js";
import type { State, TradeIntent } from "./state.js";
import { getBalance, executeSwap } from "./wallet.js";
import type { TradeOrder } from "./wallet.js";
import { checkStopLoss, validateIntent } from "./safety.js";
import { invokeCodex } from "./codex.js";
import { startDashboard } from "./ui.js";

const log = createLogger("loop");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Async mutex — prevents stop-loss and Codex loops from executing trades
// or mutating state simultaneously.
// ---------------------------------------------------------------------------

type Mutex = { acquire(): Promise<() => void> };

function createMutex(): Mutex {
  let current: Promise<void> = Promise.resolve();
  return {
    async acquire(): Promise<() => void> {
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = current;
      current = next;
      await prev;
      return release;
    },
  };
}

// ---------------------------------------------------------------------------
// executeIntent — validate and execute a single trade intent
// ---------------------------------------------------------------------------

async function executeIntent(
  state: State,
  intent: TradeIntent
): Promise<void> {
  const error = validateIntent(intent);
  if (error) {
    log.warn(`Intent ${intent.id} rejected: ${error}`);
    state.failedCount++;
    return;
  }

  const order: TradeOrder = {
    action: intent.action,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    amountLamports: intent.amountLamports,
    slippageBps: intent.slippageBps,
  };

  const result = await executeSwap(intent.id, order);
  applyResult(state, intent, result);

  if (result.success) {
    log.info(
      `[Filled] ${intent.action.toUpperCase()} ${intent.metadata?.tokenSymbol ?? intent.outputMint.slice(0, 6)} tx=${result.txHash ?? "n/a"}`
    );
  } else {
    log.warn(
      `[Failed] ${intent.action.toUpperCase()} ${intent.metadata?.tokenSymbol ?? intent.outputMint.slice(0, 6)}: ${result.error}`
    );
  }
}

// ---------------------------------------------------------------------------
// Stop-loss loop — runs independently at a fast interval (default 10s)
// ---------------------------------------------------------------------------

async function runStopLossLoop(
  state: State,
  signal: AbortSignal,
  mutex: Mutex
): Promise<void> {
  const intervalMs = config.stopLossIntervalSeconds * 1000;
  log.info(`Stop-loss loop started (interval: ${config.stopLossIntervalSeconds}s)`);

  while (!signal.aborted) {
    await Promise.race([
      sleep(intervalMs),
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);

    if (signal.aborted) break;

    // Skip if no positions — avoids unnecessary Jupiter API calls
    if (Object.keys(state.positions).length === 0) continue;

    const release = await mutex.acquire();
    try {
      const intents = await checkStopLoss(state);
      for (const intent of intents) {
        if (signal.aborted) break;
        await executeIntent(state, intent);
      }
      if (intents.length > 0) {
        await saveState(state);
      }
    } catch (e) {
      log.error(`Stop-loss check error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
    }
  }

  log.info("Stop-loss loop stopped.");
}

// ---------------------------------------------------------------------------
// Main loop — Codex cycle at scanIntervalSeconds (default 90s)
// ---------------------------------------------------------------------------

export async function runLoop(signal: AbortSignal): Promise<void> {
  log.info("CashCat Agent starting...");
  log.info(`Scan interval: ${config.scanIntervalSeconds}s`);

  // Determine initial cash from wallet if no existing state
  let realCashLamports: string | undefined;
  const stateExists = await fs
    .access(config.statePath)
    .then(() => true)
    .catch(() => false);

  if (!stateExists) {
    try {
      const balance = await getBalance();
      realCashLamports = balance.lamports;
      log.info(`Wallet balance: ${balance.sol} SOL (${balance.lamports} lamports)`);
    } catch (e) {
      log.warn(`Failed to fetch wallet balance: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const state = await loadState(realCashLamports);
  log.info(
    `State loaded: cycle=${state.cycle}, ${getSummary(state)}`
  );

  // Ensure Codex-accessible files exist so it can always read them
  const observationsPath = path.resolve("observations.md");
  try { await fs.access(observationsPath); } catch {
    await fs.writeFile(observationsPath, "# Market Observations\n\n## Summary\n\n(No compacted summaries yet)\n\n## Recent\n\n(No observations yet)\n");
  }

  startDashboard();

  const mutex = createMutex();

  // Fire-and-forget: stop-loss loop runs concurrently
  runStopLossLoop(state, signal, mutex).catch((e) => {
    log.error(`Stop-loss loop crashed: ${e instanceof Error ? e.message : String(e)}`);
  });

  while (!signal.aborted) {
    state.cycle++;
    log.info(`=== Cycle #${state.cycle} ===`);

    // Codex agent (mutex-protected)
    if (!signal.aborted) {
      const release = await mutex.acquire();
      try {
        // Sync wallet SOL balance with state
        try {
          const balance = await getBalance();
          const walletLamports = BigInt(balance.lamports);
          const stateLamports = BigInt(state.cashLamports);
          const diff = walletLamports - stateLamports;
          const absDiff = diff < 0n ? -diff : diff;

          if (absDiff > 1_000_000n) {
            state.cashLamports = walletLamports.toString();
            const initialLamports = BigInt(state.initialCashLamports ?? state.cashLamports);
            state.initialCashLamports = (initialLamports + diff).toString();

            const diffSol = Number(diff) / 1_000_000_000;
            if (diff > 0n) {
              log.info(`Deposit detected: +${diffSol.toFixed(4)} SOL — cashLamports synced to wallet`);
            } else {
              log.info(`Withdrawal detected: ${diffSol.toFixed(4)} SOL — cashLamports synced to wallet`);
            }
          }
        } catch {
          // getBalance failed — skip sync, continue with stale cashLamports
        }

        const { intents, notes } = await invokeCodex(state, new Date());
        for (const note of notes) {
          log.info(note);
        }
        for (const intent of intents) {
          if (signal.aborted) break;
          await executeIntent(state, intent);
        }
      } catch (e) {
        log.warn(`Codex invocation failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        release();
      }
    }

    // Save state
    await saveState(state);
    log.info(`[Summary] ${getSummary(state)}`);

    // Wait
    if (!signal.aborted) {
      const waitMs = config.scanIntervalSeconds * 1000;
      log.info(`Waiting ${config.scanIntervalSeconds}s for next cycle...`);
      await Promise.race([
        sleep(waitMs),
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    }
  }

  log.info("Agent stopped.");
}
