import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { loadState, saveState, applyResult, applyPerpOpen, applyPerpClose, writeOffPerp, getSummary } from "./state.js";
import type { State, TradeIntent } from "./state.js";
import { getBalance, executeSwap, signAndSendTransaction } from "./wallet.js";
import type { TradeOrder } from "./wallet.js";
import { buildOpenPositionTx, buildClosePositionTx, buildInitializeUserTx, getUsdcBalanceUsd } from "./perps.js";
import { checkStopLoss, checkPerpStopLoss, checkPerpWriteOffs, validateIntent } from "./safety.js";
import { invokeCodex } from "./codex.js";
import { startDashboard } from "./ui.js";

const log = createLogger("loop");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendLedgerEvent(
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const ledgerPath = config.ledgerReadPath;
  const event = { timestamp: new Date().toISOString(), type, payload };
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, JSON.stringify(event) + "\n", "utf8");
}

async function fetchPriceUsd(mint: string): Promise<number> {
  try {
    const url = new URL(`${config.jupiter.baseUrl}/price/v3`);
    url.searchParams.set("ids", mint);
    const res = await fetch(url.toString());
    if (!res.ok) return 0;
    const payload = (await res.json()) as Record<string, unknown>;
    const data = (payload?.data ?? payload) as Record<string, unknown>;
    const row = data[mint] as Record<string, unknown> | undefined;
    const price = Number(row?.usdPrice ?? row?.price ?? row?.priceUsd ?? row?.value ?? 0);
    return Number.isFinite(price) && price > 0 ? price : 0;
  } catch {
    return 0;
  }
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

  // Perp intents are handled entirely in-agent (no wallet-mcp)
  if (intent.action === "perp_open") {
    await executePerpOpen(state, intent);
    return;
  }
  if (intent.action === "perp_close") {
    await executePerpClose(state, intent);
    return;
  }

  const order: TradeOrder = {
    action: intent.action as "buy" | "sell",
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

async function executePerpOpen(state: State, intent: TradeIntent): Promise<void> {
  const market = intent.metadata.perpMarket as string;
  const side = intent.metadata.perpSide as "long" | "short";
  const leverage = intent.metadata.leverage as number;
  const collateralUsd = intent.metadata.collateralUsd as number;
  const underlyingMint = intent.inputMint;

  const entryPrice = await fetchPriceUsd(underlyingMint);
  if (entryPrice <= 0) {
    log.warn(`[PerpFailed] ${market}: could not fetch entry price`);
    state.failedCount++;
    return;
  }

  // Real on-chain perp: build tx → sign & send via wallet-mcp
  if (!config.perps.paperOnly && config.solanaWalletAddress) {
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const walletPubkey = new PublicKey(config.solanaWalletAddress);
      const txBase64 = await buildOpenPositionTx(
        walletPubkey,
        market,
        side,
        leverage,
        collateralUsd,
        entryPrice
      );
      const result = await signAndSendTransaction(
        intent.id,
        txBase64,
        `Open ${market} ${side} ${leverage}x collateral=$${collateralUsd.toFixed(2)}`
      );
      if (!result.success) {
        log.warn(`[PerpFailed] ${market}: tx failed: ${result.error}`);
        state.failedCount++;
        return;
      }
      log.info(`[PerpTxSent] ${market} ${side} ${leverage}x tx=${result.txHash ?? "n/a"}`);
    } catch (e) {
      log.warn(`[PerpFailed] ${market}: tx build/send error: ${e instanceof Error ? e.message : String(e)}`);
      state.failedCount++;
      return;
    }
  }

  applyPerpOpen(state, market, underlyingMint, side, leverage, collateralUsd, entryPrice);
  state.filledCount++;

  log.info(
    `[PerpOpened] ${market} ${side} ${leverage}x collateral=$${collateralUsd.toFixed(2)} entry=$${entryPrice.toFixed(4)}`
  );

  try {
    await appendLedgerEvent("perp_opened", {
      intentId: intent.id,
      market,
      side,
      leverage,
      collateralUsd,
      entryPriceUsd: entryPrice,
      sizeUsd: collateralUsd * leverage,
      reason: intent.metadata.reason,
      mode: config.perps.paperOnly ? "paper" : "live",
    });
  } catch (e) {
    log.warn(`Ledger write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function executePerpClose(state: State, intent: TradeIntent): Promise<void> {
  const market = intent.metadata.perpMarket as string;
  const pos = state.perpPositions[market];
  if (!pos) {
    log.warn(`[PerpFailed] ${market}: no position to close`);
    return;
  }

  const closePrice = await fetchPriceUsd(pos.underlyingMint);
  if (closePrice <= 0) {
    log.warn(`[PerpFailed] ${market}: could not fetch close price`);
    state.failedCount++;
    return;
  }

  // Real on-chain perp: build close tx → sign & send via wallet-mcp
  if (!config.perps.paperOnly && config.solanaWalletAddress) {
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const walletPubkey = new PublicKey(config.solanaWalletAddress);
      const txBase64 = await buildClosePositionTx(
        walletPubkey,
        market,
        pos.side,
        closePrice
      );
      const result = await signAndSendTransaction(
        intent.id,
        txBase64,
        `Close ${market} ${pos.side} ${pos.leverage}x`
      );
      if (!result.success) {
        // Track consecutive close failures for backoff
        pos.closeFailCount = (pos.closeFailCount ?? 0) + 1;
        pos.lastCloseFailedAt = new Date().toISOString();
        const isCollateralError = result.error?.includes("InsufficientCollateral") || result.error?.includes("0x1773");
        if (isCollateralError && pos.closeFailCount >= 3) {
          log.error(`[PerpStuck] ${market}: InsufficientCollateral after ${pos.closeFailCount} attempts. Position may need manual intervention (deposit collateral via Drift UI or wait for liquidation). Backing off to 5-min retry.`);
        } else {
          log.warn(`[PerpFailed] ${market}: close tx failed: ${result.error}`);
        }
        state.failedCount++;
        return;
      }
      // Reset failure tracking on success
      pos.closeFailCount = undefined;
      pos.lastCloseFailedAt = undefined;
      log.info(`[PerpCloseTxSent] ${market} ${pos.side} tx=${result.txHash ?? "n/a"}`);
    } catch (e) {
      pos.closeFailCount = (pos.closeFailCount ?? 0) + 1;
      pos.lastCloseFailedAt = new Date().toISOString();
      log.warn(`[PerpFailed] ${market}: close tx build/send error: ${e instanceof Error ? e.message : String(e)}`);
      state.failedCount++;
      return;
    }
  }

  const { pnlUsd } = applyPerpClose(state, market, closePrice);
  state.filledCount++;

  const pnlSign = pnlUsd >= 0 ? "+" : "";
  log.info(
    `[PerpClosed] ${market} ${pos.side} ${pos.leverage}x close=$${closePrice.toFixed(4)} pnl=${pnlSign}$${pnlUsd.toFixed(2)} reason=${intent.metadata.reason ?? "manual"}`
  );

  try {
    await appendLedgerEvent("perp_closed", {
      intentId: intent.id,
      market,
      side: pos.side,
      leverage: pos.leverage,
      entryPriceUsd: pos.entryPriceUsd,
      closePriceUsd: closePrice,
      pnlUsd,
      collateralUsd: pos.collateralUsd,
      sizeUsd: pos.sizeUsd,
      reason: intent.metadata.reason,
      mode: config.perps.paperOnly ? "paper" : "live",
    });
  } catch (e) {
    log.warn(`Ledger write failed: ${e instanceof Error ? e.message : String(e)}`);
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

    const hasSpotPositions = Object.keys(state.positions).length > 0;
    const hasPerpPositions = Object.keys(state.perpPositions).length > 0;

    // Skip if no positions at all — avoids unnecessary Jupiter API calls
    if (!hasSpotPositions && !hasPerpPositions) continue;

    const release = await mutex.acquire();
    try {
      const intents: TradeIntent[] = [];

      if (hasSpotPositions) {
        const spotIntents = await checkStopLoss(state);
        intents.push(...spotIntents);
      }

      if (hasPerpPositions) {
        const perpIntents = await checkPerpStopLoss(state);
        intents.push(...perpIntents);
      }

      for (const intent of intents) {
        if (signal.aborted) break;
        await executeIntent(state, intent);
      }

      // Write-off stuck perp positions
      const writeOffMarkets = checkPerpWriteOffs(state);
      for (const market of writeOffMarkets) {
        const pos = state.perpPositions[market];
        if (!pos) continue;
        const { pnlUsd } = writeOffPerp(state, market);
        log.warn(`[WriteOff] ${market} ${pos.side} ${pos.leverage}x: wrote off collateral=$${pos.collateralUsd.toFixed(2)}, pnl=$${pnlUsd.toFixed(2)} (failCount=${pos.closeFailCount ?? 0})`);
        try {
          await appendLedgerEvent("perp_write_off", {
            market,
            side: pos.side,
            leverage: pos.leverage,
            collateralUsd: pos.collateralUsd,
            entryPriceUsd: pos.entryPriceUsd,
            pnlUsd,
            closeFailCount: pos.closeFailCount ?? 0,
            reason: "stuck_position_write_off",
          });
        } catch (e) {
          log.warn(`Ledger write failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (intents.length > 0 || writeOffMarkets.length > 0) {
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

  // Initialize Drift user account if perps are enabled and in real mode
  if (config.perps.enabled && !config.perps.paperOnly && config.solanaWalletAddress) {
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const walletPubkey = new PublicKey(config.solanaWalletAddress);
      const initTx = await buildInitializeUserTx(walletPubkey);
      if (initTx) {
        log.info("Drift user account not found, initializing...");
        const result = await signAndSendTransaction(
          `drift-init-${Date.now()}`,
          initTx,
          "Initialize Drift user account"
        );
        if (result.success) {
          log.info(`Drift user account initialized: tx=${result.txHash ?? "n/a"}`);
        } else {
          log.warn(`Drift user account init failed: ${result.error}`);
        }
      }
    } catch (e) {
      log.warn(`Drift init check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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

        // Sync USDC balance → perpBalanceUsd (real mode only)
        if (config.perps.enabled && !config.perps.paperOnly && config.solanaWalletAddress) {
          try {
            const { PublicKey } = await import("@solana/web3.js");
            const walletPubkey = new PublicKey(config.solanaWalletAddress);
            const usdcBalance = await getUsdcBalanceUsd(walletPubkey);
            state.perpBalanceUsd = usdcBalance;
            log.info(`USDC balance synced: $${usdcBalance.toFixed(2)}`);
          } catch (e) {
            log.warn(`USDC balance sync failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // Safety net: trim observations.md if it grew too large (Codex should compact, but may miss)
        try {
          const obsContent = await fs.readFile(observationsPath, "utf8");
          const obsLines = obsContent.split("\n");
          if (obsLines.length > 200) {
            log.warn(`observations.md has ${obsLines.length} lines (>200), trimming Recent section`);
            const recentIdx = obsContent.indexOf("## Recent");
            if (recentIdx !== -1) {
              const beforeRecent = obsContent.slice(0, recentIdx);
              const recentSection = obsContent.slice(recentIdx);
              const entries = recentSection.split(/(?=^### Cycle )/m);
              const header = entries[0]; // "## Recent\n"
              const cycleEntries = entries.slice(1);
              if (cycleEntries.length > 15) {
                const kept = cycleEntries.slice(-10);
                const trimmed = beforeRecent + header + kept.join("");
                await fs.writeFile(observationsPath, trimmed);
                log.info(`Trimmed observations.md: kept last 10 of ${cycleEntries.length} entries`);
              }
            }
          }
        } catch { /* non-fatal */ }

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
