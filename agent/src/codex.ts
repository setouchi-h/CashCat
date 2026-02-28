import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { loginWithOAuth } from "./auth.js";
import type { State, TradeIntent, PerpPosition } from "./state.js";

const log = createLogger("codex");
const execFileAsync = promisify(execFile);

const SOL_MINT = "So11111111111111111111111111111111111111112";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodexDecision {
  action?: unknown;
  symbol?: unknown;
  mint?: unknown;
  decimals?: unknown;
  amountLamports?: unknown;
  slippageBps?: unknown;
  reason?: unknown;
  confidence?: unknown;
  perpMarket?: unknown;
  perpSide?: unknown;
  leverage?: unknown;
  collateralUsd?: unknown;
}

interface CodexOutput {
  notes?: unknown;
  intents?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBigint(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function toNumber(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(num) ? num : 0;
}

function toPositiveInteger(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function makeIntentId(symbol: string, action: "buy" | "sell"): string {
  return `agentic-${Date.now()}-${symbol.toLowerCase()}-${action}-${randomUUID().slice(0, 6)}`;
}

function calcBuyLamports(cashLamports: bigint): bigint {
  if (cashLamports <= 0n) return 0n;
  const minLamports = BigInt(Math.floor(config.minTradeSol * 1_000_000_000));
  if (cashLamports < minLamports) return 0n;
  return cashLamports;
}

function normalizeBuyLamports(requested: unknown, cashLamports: bigint): bigint {
  const minLamports = BigInt(Math.floor(config.minTradeSol * 1_000_000_000));

  const requestedInt = toPositiveInteger(requested);
  let amount = requestedInt !== null ? BigInt(requestedInt) : calcBuyLamports(cashLamports);

  if (amount < minLamports) amount = minLamports;
  if (amount > cashLamports) amount = cashLamports;
  if (amount < minLamports) return 0n;
  return amount;
}

function calcSellRaw(rawAmount: bigint): bigint {
  if (rawAmount <= 0n) return 0n;
  if (config.sellFraction >= 0.999) {
    const adjusted = (rawAmount * 995n) / 1000n;
    return adjusted > 0n ? adjusted : rawAmount;
  }
  const ppm = BigInt(Math.max(1, Math.floor(config.sellFraction * 1_000_000)));
  const value = (rawAmount * ppm) / 1_000_000n;
  if (value > 0n) return value;
  return rawAmount;
}

function normalizeSellRaw(requested: unknown, heldRaw: bigint): bigint {
  if (heldRaw <= 0n) return 0n;
  const requestedInt = toPositiveInteger(requested);
  const desired = requestedInt !== null ? BigInt(requestedInt) : calcSellRaw(heldRaw);
  return minBigint(heldRaw, desired);
}

function normalizeSlippageBps(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return config.intentSlippageBps;
  }
  return Math.floor(clamp(parsed, 1, config.maxSlippageBps));
}

function isValidMint(value: string): boolean {
  if (!value || value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function resolveToken(decision: CodexDecision): { mint: string; symbol: string; decimals: number } | null {
  const mint = typeof decision.mint === "string" ? decision.mint.trim() : "";
  const symbol = typeof decision.symbol === "string" ? decision.symbol.trim().toUpperCase() : "";

  if (!mint || !isValidMint(mint)) return null;

  const decimals = typeof decision.decimals === "number" && Number.isInteger(decision.decimals)
    ? decision.decimals
    : 9;
  return { mint, symbol: symbol || mint.slice(0, 6), decimals };
}

async function fetchPricesUsd(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  try {
    const url = new URL(`${config.jupiter.baseUrl}/price/v3`);
    url.searchParams.set("ids", mints.join(","));
    const res = await fetch(url.toString());
    if (!res.ok) {
      log.warn(`[Price] HTTP ${res.status}`);
      return {};
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const data = (payload?.data ?? payload) as Record<string, unknown>;
    const prices: Record<string, number> = {};
    for (const mint of mints) {
      const row = data[mint] as Record<string, unknown> | undefined;
      const price = toNumber(row?.usdPrice ?? row?.price ?? row?.priceUsd ?? row?.value);
      prices[mint] = price > 0 ? price : 0;
    }
    return prices;
  } catch (e) {
    log.warn(`[Price] ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function summarizeCodexExecError(raw: string): string {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "codex exec failed";

  const important = lines.filter((line) =>
    /ERROR|error|failed|Reconnecting|Not logged in|mcp startup/i.test(line)
  );
  if (important.length > 0) {
    return important.slice(-4).join(" | ").slice(0, 500);
  }

  return lines.slice(-6).join(" | ").slice(0, 500);
}

// ---------------------------------------------------------------------------
// Codex home preparation
// ---------------------------------------------------------------------------

function getCodexSourceHome(): string {
  const codexHome = (process.env.CODEX_HOME ?? "").trim();
  if (codexHome) return codexHome;
  const home = process.env.HOME?.trim() || os.homedir();
  return path.join(home, ".codex");
}

interface CodexAuthFile {
  auth_mode: string;
  OPENAI_API_KEY: string | null;
  tokens: {
    access_token: string;
    refresh_token: string;
    [key: string]: unknown;
  };
  last_refresh: string;
}

async function ensureCodexAuth(sourceHome: string): Promise<void> {
  const authPath = path.join(sourceHome, "auth.json");

  try {
    const raw = await fs.readFile(authPath, "utf8");
    const data = JSON.parse(raw) as CodexAuthFile;
    if (data.tokens?.access_token && data.tokens?.refresh_token) {
      return; // auth exists
    }
    log.info("Codex auth.json is incomplete. Re-authenticating...");
  } catch {
    log.info("Codex auth not found. Starting OAuth login...");
  }

  const tokens = await loginWithOAuth();

  const codexAuth: CodexAuthFile = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };

  await fs.mkdir(sourceHome, { recursive: true });
  await fs.writeFile(authPath, JSON.stringify(codexAuth, null, 2), { mode: 0o600 });
  log.info("Codex auth saved");
}

async function prepareCodexHome(): Promise<string> {
  const sourceHome = getCodexSourceHome();
  const plannerHome = path.join(os.tmpdir(), "cashcat-runtime", "codex-planner-home");
  await fs.mkdir(plannerHome, { recursive: true });

  await ensureCodexAuth(sourceHome);

  const sourceAuthPath = path.join(sourceHome, "auth.json");
  const plannerAuthPath = path.join(plannerHome, "auth.json");
  await fs.copyFile(sourceAuthPath, plannerAuthPath);

  const plannerConfigPath = path.join(plannerHome, "config.toml");
  const plannerConfig = [
    'model = "gpt-5.3-codex"',
    'reasoning_effort = "medium"',
  ].join("\n");
  await fs.writeFile(plannerConfigPath, `${plannerConfig}\n`, "utf8");

  return plannerHome;
}

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

function buildPerpPromptSection(state: State): string {
  if (!config.perps.enabled) return "";

  const openMarkets = Object.keys(state.perpPositions).join(", ") || "(none)";
  const perpPositionLines = Object.values(state.perpPositions).map((p: PerpPosition) => {
    return `  ${p.market} ${p.side} ${p.leverage}x: size=$${p.sizeUsd.toFixed(2)}, collateral=$${p.collateralUsd.toFixed(2)}, entry=$${p.entryPriceUsd.toFixed(4)}, liq=$${p.liquidationPriceUsd.toFixed(4)}, borrowFee=$${p.borrowFeeUsd.toFixed(4)}, opened=${p.openedAt}`;
  });

  return `== Perpetual Futures (Paper Trading) ==
You can trade any token as a perp market. Use format "TOKEN-PERP" for perpMarket and provide the underlying token's mint address.
Max leverage: ${config.perps.maxLeverage}x
Max open perps: ${config.perps.maxOpenPerps}
Max collateral per position: ${(config.perps.maxCollateralPct * 100).toFixed(0)}% of perp balance
Open/close fee: ${(config.perps.openCloseFeeRate * 100).toFixed(3)}% of notional
Hourly borrow rate: ${(config.perps.hourlyBorrowRate * 100).toFixed(4)}%
Stop-loss / take-profit / liquidation / timeout are handled by the engine automatically.

Perp Balance: $${state.perpBalanceUsd.toFixed(2)} USD
Realized Perp PnL: $${state.realizedPerpPnlUsd.toFixed(2)} USD
Open perp positions (${Object.keys(state.perpPositions).length}):
${perpPositionLines.length > 0 ? perpPositionLines.join("\n") : "  (none)"}

`;
}

export function buildPrompt(state: State, now: Date): string {
  const cashLamports = toBigint(state.cashLamports);
  const cashSol = Number(cashLamports) / 1_000_000_000;
  const realizedSol = Number(toBigint(state.realizedPnlLamports)) / 1_000_000_000;

  const positionLines = Object.values(state.positions).map((p) => {
    const qty = Number(toBigint(p.rawAmount)) / 10 ** p.decimals;
    return `  ${p.symbol} (${p.mint}): qty=${qty}, cost=${Number(toBigint(p.costLamports)) / 1e9} SOL, opened=${p.openedAt}`;
  });

  return `You are a Solana trading agent for CashCat.
Current time: ${now.toISOString()}
Cycle: ${state.cycle}

== Portfolio ==
Cash: ${cashSol.toFixed(4)} SOL (${cashLamports.toString()} lamports)
Realized PnL: ${realizedSol.toFixed(4)} SOL
Open positions (${Object.keys(state.positions).length}):
${positionLines.length > 0 ? positionLines.join("\n") : "  (none)"}

== Strategy ==
Read strategy.md for your current trading strategy.
Update strategy.md when you learn something durable:
- After a trade fills (win or loss) — add the lesson to "## Lessons Learned".
- When you start monitoring a new token — add it to "## Token Watchlist" with mint and decimals.
- When a scan candidate consistently returns no data — note it so you deprioritize it.
- When you discover a new entry/exit pattern — add it to the appropriate rules section.
- After a perp trade closes (win or loss) — add the lesson to "## Perp Lessons Learned".
- When you discover a new perp entry/exit pattern — add it to "## Perp Entry Rules" or "## Perp Exit Rules".
Do NOT write per-cycle market observations into strategy.md — it is for durable rules and lessons only.

== Observations ==
Read observations.md for recent market observations.
Each cycle, append your market observations (prices, momentum, rationale) as a new entry under "## Recent".
Format each entry concisely — one line per token: "- SYMBOL: $price, 24h X%, liq ~$XM"
End with a one-line portfolio summary.

COMPACTION (MANDATORY — run EVERY cycle before appending):
1. Count entries (### headings) under "## Recent".
2. If count >= 15, take the oldest 10, write a 2-3 line summary covering the date range and key trends, append it to "## Summary", then DELETE those 10 entries from Recent.
3. Keep "## Summary" under 20 lines total. If exceeded, merge the oldest summary lines into fewer lines.
4. Never duplicate cycle numbers. If the current cycle number already exists, skip writing a new entry.
After compaction, the file should stay under 120 lines total.

== Trade History ==
Read ${config.ledgerReadPath} for the full trade ledger (JSONL format).
Filter for type "swap_filled" and "swap_failed" entries to see past trade results.
Each entry has: timestamp, type, payload (with intentId, txHash, inputMint, outputMint, inputAmount, outputAmount).
Analyze wins/losses and incorporate lessons into your strategy file.

== Trading ==
You may trade ANY Solana SPL token. Use Jupiter Price API to research prices and discover tokens.
You MUST include the mint address and decimals for every token in your intents.

SOL mint: ${SOL_MINT}

== Price API ==
Jupiter Price API: curl "${config.jupiter.baseUrl}/price/v3?ids=<mint1>,<mint2>"
Returns JSON: { "<mint>": { "usdPrice": number, "priceChange24h": number, "liquidity": number } }

== Hard Constraints ==
- Max intents per cycle: ${config.maxIntentsPerCycle}
- Min trade: ${config.minTradeSol} SOL
- Max open positions: ${config.maxOpenPositions}
- Max slippage: ${config.maxSlippageBps} bps, default slippage: ${config.intentSlippageBps} bps
- Stop-loss / take-profit / timeout are handled by the engine automatically. Do NOT generate stop-loss sells.

${buildPerpPromptSection(state)}== Output Format ==
Return ONLY valid JSON (no markdown, no explanation) with keys:
{
  "notes": ["string array of your reasoning"],
  "intents": [
    {
      "action": "buy" | "sell"${config.perps.enabled ? ' | "perp_open" | "perp_close"' : ""},
      "symbol": "TOKEN_SYMBOL",
      "mint": "MINT_ADDRESS",
      "decimals": number,
      "amountLamports": number,
      "slippageBps": number,
      "reason": "brief reason",
      "confidence": 0.0-1.0${config.perps.enabled ? `,
      "perpMarket": "SOL-PERP",
      "perpSide": "long" | "short",
      "leverage": number,
      "collateralUsd": number` : ""}
    }
  ]
}

For buys: amountLamports is SOL amount to spend. For sells: amountLamports is raw token amount to sell.${config.perps.enabled ? `
For perp_open: perpMarket, perpSide, leverage, collateralUsd, and mint (underlying token mint) are required. amountLamports/slippageBps are ignored.
For perp_close: only perpMarket is required.` : ""}
If no action is warranted, return { "notes": ["reason"], "intents": [] }.`;
}

// ---------------------------------------------------------------------------
// invokeCodex
// ---------------------------------------------------------------------------

function isTokenError(message: string): boolean {
  return /token data is not available|not logged in|unauthorized|auth/i.test(message);
}

async function invalidateCodexAuth(): Promise<void> {
  const sourceHome = getCodexSourceHome();
  const authPath = path.join(sourceHome, "auth.json");
  await fs.rm(authPath, { force: true });
  log.info("Invalidated codex auth for re-login");
}

async function runCodexExec(
  prompt: string,
  codexHome: string,
  outputPath: string,
  timeoutMs: number
): Promise<CodexOutput> {
  try {
    await execFileAsync(
      "codex",
      ["exec", "--full-auto", "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check", "-o", outputPath, prompt],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome },
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      }
    );
  } catch (e) {
    const err = e as ExecFileException & { stdout?: string; stderr?: string };
    const detail =
      (err.stderr ?? "").trim() ||
      (err.stdout ?? "").trim() ||
      err.message ||
      String(e);
    throw new Error(`codex exec failed: ${summarizeCodexExecError(detail)}`);
  }

  const outputText = (await fs.readFile(outputPath, "utf8")).trim();
  if (!outputText) {
    throw new Error("codex exec returned empty output");
  }

  try {
    return JSON.parse(outputText) as CodexOutput;
  } catch {
    const jsonText = extractFirstJsonObject(outputText);
    if (!jsonText) {
      throw new Error(`codex exec output was not valid JSON: ${outputText.slice(0, 200)}`);
    }
    return JSON.parse(jsonText) as CodexOutput;
  }
}

export async function invokeCodex(
  state: State,
  now: Date
): Promise<{ intents: TradeIntent[]; notes: string[] }> {
  const prompt = buildPrompt(state, now);
  const timeoutMs = config.codexTimeoutSeconds * 1000;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cashcat-codex-planner-"));
  const outputPath = path.join(tmpDir, "output.json");

  let raw: CodexOutput;
  try {
    const codexHome = await prepareCodexHome();
    try {
      raw = await runCodexExec(prompt, codexHome, outputPath, timeoutMs);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!isTokenError(message)) throw e;

      // Token error — invalidate and retry with fresh login
      log.warn("Codex token error, re-authenticating...");
      await invalidateCodexAuth();
      const freshHome = await prepareCodexHome();
      raw = await runCodexExec(prompt, freshHome, outputPath, timeoutMs);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const positionMints = Object.keys(state.positions);
  const prices = await fetchPricesUsd([SOL_MINT, ...positionMints]);
  const solPriceUsd = prices[SOL_MINT] ?? 0;
  return normalizeCodexOutput(raw, state, now, solPriceUsd, prices);
}

// ---------------------------------------------------------------------------
// normalizePerpDecision — validate and normalize a single perp intent from Codex
// ---------------------------------------------------------------------------

function normalizePerpDecision(
  decision: CodexDecision,
  action: string,
  state: State,
  nowMs: number,
  minGapMs: number,
  notes: string[]
): TradeIntent | null {
  if (!config.perps.enabled) return null;

  const market = typeof decision.perpMarket === "string"
    ? decision.perpMarket.trim().toUpperCase()
    : "";
  if (!market) {
    notes.push(`[Codex] SKIP ${action}: missing market name`);
    return null;
  }

  // cooldown check using market name as key
  const lastAt = state.lastIntentAt[market] ?? 0;
  if (nowMs - lastAt < minGapMs) return null;

  const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
  const confidence = clamp(toNumber(decision.confidence), 0, 1);

  if (action === "perp_close") {
    const pos = state.perpPositions[market];
    if (!pos) {
      notes.push(`[Codex] SKIP perp_close ${market}: no open position`);
      return null;
    }

    state.lastIntentAt[market] = nowMs;
    notes.push(`[Codex] PERP_CLOSE ${market}${reason ? ` reason=${reason}` : ""}`);

    return {
      id: `agentic-${Date.now()}-${market.toLowerCase()}-perp_close-${randomUUID().slice(0, 6)}`,
      action: "perp_close",
      inputMint: pos.underlyingMint,
      outputMint: "",
      amountLamports: 0,
      slippageBps: 0,
      metadata: {
        planner: "codex-agent",
        perpMarket: market,
        reason,
        confidence,
      },
    };
  }

  // perp_open — AI must provide underlying token mint
  const mint = typeof decision.mint === "string" ? decision.mint.trim() : "";
  if (!mint || !isValidMint(mint)) {
    notes.push(`[Codex] SKIP perp_open ${market}: missing or invalid underlying mint`);
    return null;
  }

  if (state.perpPositions[market]) {
    notes.push(`[Codex] SKIP perp_open ${market}: position already open`);
    return null;
  }

  if (Object.keys(state.perpPositions).length >= config.perps.maxOpenPerps) {
    notes.push(`[Codex] SKIP perp_open: max open perps (${config.perps.maxOpenPerps}) reached`);
    return null;
  }

  const side = typeof decision.perpSide === "string"
    ? decision.perpSide.trim().toLowerCase()
    : "";
  if (side !== "long" && side !== "short") {
    notes.push(`[Codex] SKIP perp_open ${market}: invalid side "${side}"`);
    return null;
  }

  const leverage = clamp(
    Math.floor(toNumber(decision.leverage)),
    1,
    config.perps.maxLeverage
  );

  let collateralUsd = toNumber(decision.collateralUsd);
  const maxCollateral = state.perpBalanceUsd * config.perps.maxCollateralPct;
  if (collateralUsd <= 0 || collateralUsd > maxCollateral) {
    collateralUsd = Math.min(collateralUsd > 0 ? collateralUsd : maxCollateral, maxCollateral);
  }
  if (collateralUsd <= 0 || collateralUsd > state.perpBalanceUsd) {
    notes.push(`[Codex] SKIP perp_open ${market}: insufficient perp balance ($${state.perpBalanceUsd.toFixed(2)})`);
    return null;
  }

  // Account for open/close fees in balance check
  const fee = collateralUsd * leverage * config.perps.openCloseFeeRate;
  if (collateralUsd + fee > state.perpBalanceUsd) {
    collateralUsd = (state.perpBalanceUsd - fee * 2) / (1 + leverage * config.perps.openCloseFeeRate);
    if (collateralUsd <= 0) {
      notes.push(`[Codex] SKIP perp_open ${market}: insufficient balance for fees`);
      return null;
    }
  }

  state.lastIntentAt[market] = nowMs;
  notes.push(
    `[Codex] PERP_OPEN ${market} ${side} ${leverage}x collateral=$${collateralUsd.toFixed(2)}${reason ? ` reason=${reason}` : ""}`
  );

  return {
    id: `agentic-${Date.now()}-${market.toLowerCase()}-perp_open-${randomUUID().slice(0, 6)}`,
    action: "perp_open",
    inputMint: mint,
    outputMint: "",
    amountLamports: 0,
    slippageBps: 0,
    metadata: {
      planner: "codex-agent",
      perpMarket: market,
      perpSide: side,
      leverage,
      collateralUsd,
      reason,
      confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeCodexOutput — sanitize + clamp codex decisions
// ---------------------------------------------------------------------------

function normalizeCodexOutput(
  output: CodexOutput,
  state: State,
  now: Date,
  solPriceUsd: number,
  prices: Record<string, number>
): { intents: TradeIntent[]; notes: string[] } {
  const notes: string[] = [];
  const modelNotes = Array.isArray(output.notes)
    ? output.notes.filter((item): item is string => typeof item === "string")
    : [];
  for (const line of modelNotes.slice(0, 8)) {
    notes.push(`[Codex] ${line.trim()}`);
  }

  const rawIntents = Array.isArray(output.intents) ? output.intents : [];
  const intents: TradeIntent[] = [];
  const nowMs = now.getTime();
  const minGapMs = config.minIntentGapSeconds * 1000;

  let simulatedCash = toBigint(state.cashLamports);
  let openPositions = Object.keys(state.positions).length;

  for (const raw of rawIntents) {
    if (intents.length >= config.maxIntentsPerCycle) break;
    if (!raw || typeof raw !== "object") continue;

    const decision = raw as CodexDecision;
    const action =
      typeof decision.action === "string"
        ? decision.action.trim().toLowerCase()
        : "";

    // Handle perp intents separately
    if (action === "perp_open" || action === "perp_close") {
      const perpIntent = normalizePerpDecision(decision, action, state, nowMs, minGapMs, notes);
      if (perpIntent) intents.push(perpIntent);
      continue;
    }

    if (action !== "buy" && action !== "sell") continue;

    const token = resolveToken(decision);
    if (!token) continue;

    // cooldown check
    const lastAt = state.lastIntentAt[token.mint] ?? 0;
    if (nowMs - lastAt < minGapMs) continue;

    const slippageBps = normalizeSlippageBps(decision.slippageBps);
    const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
    const confidence = clamp(toNumber(decision.confidence), 0, 1);

    if (action === "buy") {
      if (openPositions >= config.maxOpenPositions) continue;

      const amount = normalizeBuyLamports(decision.amountLamports, simulatedCash);
      if (amount <= 0n) continue;

      intents.push({
        id: makeIntentId(token.symbol, "buy"),
        action: "buy",
        inputMint: SOL_MINT,
        outputMint: token.mint,
        amountLamports: Number(amount),
        slippageBps,
        metadata: {
          planner: "codex-agent",
          tokenSymbol: token.symbol,
          decimals: token.decimals,
          reason,
          confidence,
        },
      });

      simulatedCash -= amount;
      openPositions++;
      state.lastIntentAt[token.mint] = nowMs;
      notes.push(
        `[Codex] BUY ${token.symbol} amount=${(Number(amount) / 1_000_000_000).toFixed(3)} SOL${reason ? ` reason=${reason}` : ""}`
      );
      continue;
    }

    // sell
    const position = state.positions[token.mint];
    if (!position) continue;

    // Skip sell if position market value is below minimum trade threshold
    const tokenPriceUsd = prices[token.mint] ?? 0;
    if (tokenPriceUsd > 0 && position.decimals >= 0) {
      const heldRaw = toBigint(position.rawAmount);
      const valueUsd = (Number(heldRaw) / 10 ** position.decimals) * tokenPriceUsd;
      if (valueUsd < config.minTradeValueUsd) {
        notes.push(
          `[Codex] SKIP SELL ${token.symbol}: market value $${valueUsd.toFixed(4)} below min $${config.minTradeValueUsd}`
        );
        continue;
      }
    }

    const heldRaw = toBigint(position.rawAmount);
    const sellRaw = normalizeSellRaw(decision.amountLamports, heldRaw);
    if (sellRaw <= 0n) continue;

    intents.push({
      id: makeIntentId(token.symbol, "sell"),
      action: "sell",
      inputMint: token.mint,
      outputMint: SOL_MINT,
      amountLamports: Number(sellRaw),
      slippageBps,
      metadata: {
        planner: "codex-agent",
        tokenSymbol: token.symbol,
        reason,
        confidence,
      },
    });

    state.lastIntentAt[token.mint] = nowMs;
    notes.push(
      `[Codex] SELL ${token.symbol} amountRaw=${sellRaw.toString()}${reason ? ` reason=${reason}` : ""}`
    );
  }

  return { intents, notes };
}
