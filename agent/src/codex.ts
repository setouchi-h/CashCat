import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { loginWithOAuth } from "./auth.js";
import type { State, TradeIntent } from "./state.js";

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
  const maxLamports = BigInt(Math.floor(config.maxTradeSol * 1_000_000_000));

  // Default: use maxTradeSol as default buy size, clamped to cash
  let amount = maxLamports;
  if (amount > cashLamports) amount = cashLamports;
  if (amount < minLamports) return 0n;
  return amount;
}

function normalizeBuyLamports(requested: unknown, cashLamports: bigint): bigint {
  const minLamports = BigInt(Math.floor(config.minTradeSol * 1_000_000_000));
  const maxLamports = BigInt(Math.floor(config.maxTradeSol * 1_000_000_000));

  const requestedInt = toPositiveInteger(requested);
  let amount = requestedInt !== null ? BigInt(requestedInt) : calcBuyLamports(cashLamports);

  if (amount < minLamports) amount = minLamports;
  if (amount > maxLamports) amount = maxLamports;
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

== Trading ==
You may trade ANY Solana SPL token. Use Jupiter Price API to research prices and discover tokens.
You MUST include the mint address and decimals for every token in your intents.

SOL mint: ${SOL_MINT}

== Price API ==
Jupiter Price API: curl "${config.jupiter.baseUrl}/price/v3?ids=<mint1>,<mint2>"
Returns JSON: { data: { "<mint>": { usdPrice: number } } }

== Hard Constraints ==
- Max intents per cycle: ${config.maxIntentsPerCycle}
- Min trade: ${config.minTradeSol} SOL, max trade: ${config.maxTradeSol} SOL
- Max open positions: ${config.maxOpenPositions}
- Max slippage: ${config.maxSlippageBps} bps, default slippage: ${config.intentSlippageBps} bps
- Stop-loss / take-profit / timeout are handled by the engine automatically. Do NOT generate stop-loss sells.

== Output Format ==
Return ONLY valid JSON (no markdown, no explanation) with keys:
{
  "notes": ["string array of your reasoning"],
  "intents": [
    {
      "action": "buy" | "sell",
      "symbol": "TOKEN_SYMBOL",
      "mint": "MINT_ADDRESS",
      "decimals": number,
      "amountLamports": number,
      "slippageBps": number,
      "reason": "brief reason",
      "confidence": 0.0-1.0
    }
  ]
}

For buys: amountLamports is SOL amount to spend. For sells: amountLamports is raw token amount to sell.
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
      ["exec", "--skip-git-repo-check", "-o", outputPath, prompt],
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

  return normalizeCodexOutput(raw, state, now);
}

// ---------------------------------------------------------------------------
// normalizeCodexOutput — sanitize + clamp codex decisions
// ---------------------------------------------------------------------------

function normalizeCodexOutput(
  output: CodexOutput,
  state: State,
  now: Date
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
