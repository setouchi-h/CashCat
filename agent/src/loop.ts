import fs from "node:fs/promises";
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

  startDashboard();

  while (!signal.aborted) {
    state.cycle++;
    log.info(`=== Cycle #${state.cycle} ===`);

    // 1. Stop-loss / take-profit / timeout (immediate, no Codex needed)
    try {
      const stopLossIntents = await checkStopLoss(state);
      for (const intent of stopLossIntents) {
        if (signal.aborted) break;
        await executeIntent(state, intent);
      }
    } catch (e) {
      log.error(`Stop-loss check error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. Codex agent
    if (!signal.aborted) {
      try {
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
      }
    }

    // 3. Save state
    await saveState(state);
    log.info(`[Summary] ${getSummary(state)}`);

    // 4. Wait
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
