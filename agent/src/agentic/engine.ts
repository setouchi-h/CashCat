import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config, type TokenConfig } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import type { ExecutionIntent, ExecutionResult } from "../runtime/types.js";
import type {
  AgenticPosition,
  AgenticState,
  MomentumSignal,
  PlannedIntents,
} from "./types.js";
import { computeMomentumSignal } from "./signal.js";
import { loadAgenticState, saveAgenticState } from "./state.js";

const log = createLogger("agentic");
const execFileAsync = promisify(execFile);

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface TokenContext {
  token: TokenConfig;
  history: { ts: number; priceUsd: number }[];
  signal: MomentumSignal | null;
  latestPriceUsd: number;
  position?: AgenticPosition;
  lastIntentAt: number;
  holdMinutes: number;
  pnlPct: number;
}

interface LlmDecision {
  action?: unknown;
  symbol?: unknown;
  mint?: unknown;
  amountLamports?: unknown;
  slippageBps?: unknown;
  reason?: unknown;
  confidence?: unknown;
}

interface LlmDecisionOutput {
  notes?: unknown;
  intents?: unknown;
}

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

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
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

function calcBuyLamports(cashLamports: bigint): bigint {
  if (cashLamports <= 0n) return 0n;

  const ppm = BigInt(
    Math.floor(config.runtime.agentic.tradeAllocationPct * 1_000_000)
  );
  const minLamports = BigInt(
    Math.floor(config.runtime.agentic.minTradeSol * 1_000_000_000)
  );
  const maxLamports = BigInt(
    Math.floor(config.runtime.agentic.maxTradeSol * 1_000_000_000)
  );

  let amount = (cashLamports * ppm) / 1_000_000n;
  if (amount < minLamports) amount = minLamports;
  if (amount > maxLamports) amount = maxLamports;
  if (amount > cashLamports) amount = cashLamports;

  if (amount <= 0n || amount < minLamports) return 0n;
  return amount;
}

function normalizeBuyLamports(
  requested: unknown,
  cashLamports: bigint
): bigint {
  const minLamports = BigInt(
    Math.floor(config.runtime.agentic.minTradeSol * 1_000_000_000)
  );
  const maxLamports = BigInt(
    Math.floor(config.runtime.agentic.maxTradeSol * 1_000_000_000)
  );

  const requestedInt = toPositiveInteger(requested);
  let amount =
    requestedInt !== null ? BigInt(requestedInt) : calcBuyLamports(cashLamports);

  if (amount < minLamports) amount = minLamports;
  if (amount > maxLamports) amount = maxLamports;
  if (amount > cashLamports) amount = cashLamports;
  if (amount < minLamports) return 0n;
  return amount;
}

function calcSellRaw(rawAmount: bigint): bigint {
  if (rawAmount <= 0n) return 0n;
  if (config.runtime.agentic.sellFraction >= 0.999) return rawAmount;

  const ppm = BigInt(
    Math.max(1, Math.floor(config.runtime.agentic.sellFraction * 1_000_000))
  );
  const value = (rawAmount * ppm) / 1_000_000n;
  if (value > 0n) return value;
  return rawAmount;
}

function normalizeSellRaw(requested: unknown, heldRaw: bigint): bigint {
  if (heldRaw <= 0n) return 0n;
  const requestedInt = toPositiveInteger(requested);
  const desired =
    requestedInt !== null ? BigInt(requestedInt) : calcSellRaw(heldRaw);
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
    return config.runtime.agentic.intentSlippageBps;
  }
  return Math.floor(
    clamp(parsed, 1, config.runtime.maxSlippageBps)
  );
}

function calcPositionPnlPct(
  position: AgenticPosition,
  priceUsd: number,
  solPriceUsd: number
): number {
  const rawAmount = toBigint(position.rawAmount);
  const costLamports = toBigint(position.costLamports);
  if (
    rawAmount <= 0n ||
    costLamports <= 0n ||
    priceUsd <= 0 ||
    solPriceUsd <= 0
  ) {
    return 0;
  }

  const size = Number(rawAmount) / 10 ** position.decimals;
  const marketValueUsd = size * priceUsd;
  const costBasisUsd = (Number(costLamports) / 1_000_000_000) * solPriceUsd;
  if (costBasisUsd <= 0) return 0;
  return marketValueUsd / costBasisUsd - 1;
}

function getJupiterHeaders(): HeadersInit | undefined {
  if (!config.jupiter.apiKey) return undefined;
  return { "x-api-key": config.jupiter.apiKey };
}

function buildPriceUrl(mints: string[]): string {
  const url = new URL(`${config.jupiter.baseUrl}/price/v3`);
  url.searchParams.set("ids", mints.join(","));
  return url.toString();
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

async function fetchPricesUsd(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};

  const response = await fetch(buildPriceUrl(mints), {
    headers: getJupiterHeaders(),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`Jupiter price failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as
    | Record<string, unknown>
    | { data?: Record<string, unknown> };
  const data: Record<string, unknown> =
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data &&
    typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : (payload as Record<string, unknown>);

  const prices: Record<string, number> = {};
  for (const mint of mints) {
    const row = data[mint] as Record<string, unknown> | undefined;
    const price = toNumber(
      row?.usdPrice ?? row?.price ?? row?.priceUsd ?? row?.value
    );
    prices[mint] = price > 0 ? price : 0;
  }
  return prices;
}

function appendMarketHistory(
  state: AgenticState,
  prices: Record<string, number>,
  nowMs: number
): void {
  for (const [mint, price] of Object.entries(prices)) {
    if (!Number.isFinite(price) || price <= 0) continue;
    const history = state.marketHistory[mint] ?? [];
    history.push({ ts: nowMs, priceUsd: price });
    if (history.length > config.runtime.agentic.historyKeepPoints) {
      history.splice(0, history.length - config.runtime.agentic.historyKeepPoints);
    }
    state.marketHistory[mint] = history;
  }
}

function makeIntentId(symbol: string, action: "buy" | "sell"): string {
  return `agentic-${Date.now()}-${symbol.toLowerCase()}-${action}-${randomUUID().slice(
    0,
    6
  )}`;
}

function buildTokenContexts(state: AgenticState, nowMs: number): TokenContext[] {
  const solPrice = state.marketHistory[SOL_MINT]?.at(-1)?.priceUsd ?? 0;
  return config.runtime.agentic.tokenUniverse.map((token) => {
    const history = state.marketHistory[token.mint] ?? [];
    const latestPriceUsd = history.at(-1)?.priceUsd ?? 0;
    const signal =
      history.length >= config.runtime.agentic.minHistoryPointsForSignal
        ? computeMomentumSignal(history, nowMs)
        : null;
    const position = state.positions[token.mint];
    const holdMinutes = position
      ? Math.max(0, (nowMs - Date.parse(position.openedAt)) / 60_000)
      : 0;
    const pnlPct =
      position && latestPriceUsd > 0
        ? calcPositionPnlPct(position, latestPriceUsd, solPrice)
        : 0;

    return {
      token,
      history,
      signal,
      latestPriceUsd,
      position,
      lastIntentAt: state.lastIntentAt[token.mint] ?? 0,
      holdMinutes,
      pnlPct,
    };
  });
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
    output_text?: unknown;
  };

  if (typeof obj.output_text === "string" && obj.output_text.trim()) {
    return obj.output_text;
  }

  const content = obj.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("")
      .trim();
  }
  return "";
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

function getCodexSourceHome(): string {
  const codexHome = (process.env.CODEX_HOME ?? "").trim();
  if (codexHome) return codexHome;

  const home = process.env.HOME?.trim() || os.homedir();
  return path.join(home, ".codex");
}

async function prepareCodexPlannerHome(): Promise<string> {
  const sourceHome = getCodexSourceHome();
  const plannerHome = path.join(
    os.tmpdir(),
    "cashcat-runtime",
    "codex-planner-home"
  );
  await fs.mkdir(plannerHome, { recursive: true });

  const sourceAuthPath = path.join(sourceHome, "auth.json");
  const plannerAuthPath = path.join(plannerHome, "auth.json");
  try {
    await fs.copyFile(sourceAuthPath, plannerAuthPath);
  } catch {
    throw new Error(
      `Codex auth not found at ${sourceAuthPath}. Run \`codex login\` first.`
    );
  }

  // Keep config minimal to avoid unrelated MCP startup failures from the user's global config.
  const plannerConfigPath = path.join(plannerHome, "config.toml");
  const plannerConfig = [
    'model = "gpt-5.3-codex"',
    'reasoning_effort = "medium"',
  ].join("\n");
  await fs.writeFile(plannerConfigPath, `${plannerConfig}\n`, "utf8");

  return plannerHome;
}

async function requestLlmPlanViaCodexExec(
  promptContext: Record<string, unknown>
): Promise<LlmDecisionOutput> {
  const llm = config.runtime.agentic.llm;
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cashcat-codex-planner-")
  );
  const outputPath = path.join(tmpDir, "output.json");
  const codexHome = await prepareCodexPlannerHome();

  const prompt =
    "You are a crypto execution planner.\n" +
    "Return only valid JSON (no markdown) with keys: notes (string[]) and intents (array).\n" +
    "Each intent may include: action, symbol or mint, amountLamports, slippageBps, reason, confidence.\n" +
    "Context JSON:\n" +
    JSON.stringify(promptContext);

  try {
    const timeoutMs = Math.max(30, llm.timeoutSeconds) * 1000;

    try {
      await execFileAsync(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "-o",
          outputPath,
          prompt,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
          },
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        }
      );
    } catch (e) {
      const err = e as ExecFileException & {
        stdout?: string;
        stderr?: string;
      };
      const detail =
        (err.stderr ?? "").trim() ||
        (err.stdout ?? "").trim() ||
        err.message ||
        String(e);
      throw new Error(`codex exec failed: ${summarizeCodexExecError(detail)}`);
    }

    const raw = (await fs.readFile(outputPath, "utf8")).trim();
    if (!raw) {
      throw new Error("codex exec returned empty output");
    }

    try {
      return JSON.parse(raw) as LlmDecisionOutput;
    } catch {
      const jsonText = extractFirstJsonObject(raw);
      if (!jsonText) {
        throw new Error(`codex exec output was not valid JSON: ${raw.slice(0, 200)}`);
      }
      return JSON.parse(jsonText) as LlmDecisionOutput;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function findTokenFromDecision(decision: LlmDecision): TokenConfig | null {
  const mint =
    typeof decision.mint === "string" ? decision.mint.trim() : "";
  if (mint) {
    const byMint = config.runtime.agentic.tokenUniverse.find(
      (token) => token.mint === mint
    );
    if (byMint) return byMint;
  }

  const symbol =
    typeof decision.symbol === "string"
      ? decision.symbol.trim().toUpperCase()
      : "";
  if (!symbol) return null;

  return (
    config.runtime.agentic.tokenUniverse.find((token) => token.symbol === symbol) ??
    null
  );
}

function buildLlmPromptContext(
  state: AgenticState,
  now: Date,
  nowMs: number,
  contexts: TokenContext[]
): Record<string, unknown> {
  const cashLamports = toBigint(state.cashLamports);
  const realizedPnlLamports = toBigint(state.realizedPnlLamports);
  return {
    now: now.toISOString(),
    cycle: state.cycle,
    constraints: {
      maxIntentsPerCycle: config.runtime.agentic.maxIntentsPerCycle,
      minIntentGapSeconds: config.runtime.agentic.minIntentGapSeconds,
      maxOpenPositions: config.runtime.agentic.maxOpenPositions,
      minTradeLamports: Math.floor(config.runtime.agentic.minTradeSol * 1_000_000_000),
      maxTradeLamports: Math.floor(config.runtime.agentic.maxTradeSol * 1_000_000_000),
      maxSlippageBps: config.runtime.maxSlippageBps,
      defaultSlippageBps: config.runtime.agentic.intentSlippageBps,
    },
    portfolio: {
      cashLamports: cashLamports.toString(),
      realizedPnlLamports: realizedPnlLamports.toString(),
      openPositions: Object.keys(state.positions).length,
      fills: state.filledCount,
      fails: state.failedCount,
    },
    tokens: contexts.map((context) => ({
      symbol: context.token.symbol,
      mint: context.token.mint,
      decimals: context.token.decimals,
      latestPriceUsd: context.latestPriceUsd,
      hasSignal: Boolean(context.signal),
      score: context.signal?.score ?? 0,
      momentum1m: context.signal?.momentum1m ?? 0,
      momentum5m: context.signal?.momentum5m ?? 0,
      volatility: context.signal?.volatility ?? 0,
      hasPosition: Boolean(context.position),
      positionRawAmount: context.position?.rawAmount ?? "0",
      positionCostLamports: context.position?.costLamports ?? "0",
      holdMinutes: context.holdMinutes,
      pnlPct: context.pnlPct,
      secondsSinceLastIntent: Math.max(
        0,
        Math.floor((nowMs - context.lastIntentAt) / 1000)
      ),
    })),
  };
}

async function requestLlmPlan(
  promptContext: Record<string, unknown>
): Promise<LlmDecisionOutput> {
  const llm = config.runtime.agentic.llm;
  if (!llm.enabled) {
    throw new Error("LLM planner is disabled");
  }

  // Prefer Codex OAuth path when API key is not set.
  let bearerToken = llm.apiKey.trim();
  if (!bearerToken) {
    const codexPlan = await requestLlmPlanViaCodexExec(promptContext);
    log.debug("LLM planner backend: codex exec");
    return codexPlan;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    llm.timeoutSeconds * 1000
  );

  try {
    const baseUrl = llm.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: llm.temperature,
        max_completion_tokens: llm.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a crypto execution planner. Return only valid JSON with keys `notes` and `intents`. " +
              "`intents` is an array of up to maxIntentsPerCycle objects: {action,buy/sell; symbol or mint; amountLamports; slippageBps; reason; confidence}. " +
              "Do not include markdown.",
          },
          {
            role: "user",
            content: JSON.stringify(promptContext),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `LLM planner HTTP ${response.status}: ${errorText.slice(0, 300)}`
      );
    }

    const payload = (await response.json()) as unknown;
    const text = extractAssistantText(payload);
    const jsonText = extractFirstJsonObject(text);
    if (!jsonText) {
      throw new Error("LLM response did not contain JSON object");
    }

    return JSON.parse(jsonText) as LlmDecisionOutput;
  } finally {
    clearTimeout(timeout);
  }
}

function planWithRules(
  state: AgenticState,
  now: Date,
  nowMs: number,
  contexts: TokenContext[]
): PlannedIntents {
  const intents: ExecutionIntent[] = [];
  const notes: string[] = [];
  const minGapMs = config.runtime.agentic.minIntentGapSeconds * 1000;

  let simulatedCash = toBigint(state.cashLamports);
  let openPositions = Object.keys(state.positions).length;

  for (const context of contexts) {
    if (intents.length >= config.runtime.agentic.maxIntentsPerCycle) break;
    if (!context.signal) continue;
    if (nowMs - context.lastIntentAt < minGapMs) continue;

    if (context.position) {
      const shouldSell =
        context.signal.score <= config.runtime.agentic.sellMomentumThreshold ||
        context.pnlPct >= config.runtime.agentic.takeProfitPct ||
        context.pnlPct <= config.runtime.agentic.stopLossPct ||
        context.holdMinutes >= config.runtime.agentic.maxHoldMinutes;
      if (!shouldSell) continue;

      const rawAmount = toBigint(context.position.rawAmount);
      const sellRaw = calcSellRaw(rawAmount);
      if (sellRaw <= 0n) continue;

      intents.push({
        type: "execution-intent",
        id: makeIntentId(context.token.symbol, "sell"),
        createdAt: now.toISOString(),
        expiresAt: new Date(
          nowMs + config.scanIntervalSeconds * 3000
        ).toISOString(),
        action: "sell",
        inputMint: context.token.mint,
        outputMint: SOL_MINT,
        amountLamports: Number(sellRaw),
        slippageBps: config.runtime.agentic.intentSlippageBps,
        metadata: {
          source: config.runtime.agentic.sourceTag,
          planner: "rule",
          tokenSymbol: context.token.symbol,
          score: context.signal.score,
          pnlPct: context.pnlPct,
          holdMinutes: context.holdMinutes,
        },
      });

      state.lastIntentAt[context.token.mint] = nowMs;
      notes.push(
        `[Rule] SELL ${context.token.symbol} score=${context.signal.score.toFixed(
          4
        )} pnl=${(context.pnlPct * 100).toFixed(2)}%`
      );
      continue;
    }

    if (openPositions >= config.runtime.agentic.maxOpenPositions) continue;
    if (context.signal.score < config.runtime.agentic.buyMomentumThreshold) continue;

    const buyLamports = calcBuyLamports(simulatedCash);
    if (buyLamports <= 0n) continue;

    intents.push({
      type: "execution-intent",
      id: makeIntentId(context.token.symbol, "buy"),
      createdAt: now.toISOString(),
      expiresAt: new Date(nowMs + config.scanIntervalSeconds * 3000).toISOString(),
      action: "buy",
      inputMint: SOL_MINT,
      outputMint: context.token.mint,
      amountLamports: Number(buyLamports),
      slippageBps: config.runtime.agentic.intentSlippageBps,
      metadata: {
        source: config.runtime.agentic.sourceTag,
        planner: "rule",
        tokenSymbol: context.token.symbol,
        score: context.signal.score,
        momentum1m: context.signal.momentum1m,
        momentum5m: context.signal.momentum5m,
        volatility: context.signal.volatility,
      },
    });

    simulatedCash -= buyLamports;
    openPositions++;
    state.lastIntentAt[context.token.mint] = nowMs;
    notes.push(
      `[Rule] BUY ${context.token.symbol} score=${context.signal.score.toFixed(
        4
      )} amount=${(Number(buyLamports) / 1_000_000_000).toFixed(3)} SOL`
    );
  }

  return { intents, notes };
}

function sanitizeLlmPlan(
  output: LlmDecisionOutput,
  state: AgenticState,
  now: Date,
  nowMs: number,
  contexts: TokenContext[]
): PlannedIntents {
  const notes: string[] = [];
  const modelNotes = Array.isArray(output.notes)
    ? output.notes.filter((item): item is string => typeof item === "string")
    : [];
  for (const line of modelNotes.slice(0, 8)) {
    notes.push(`[LLM] ${line.trim()}`);
  }

  const rawIntents = Array.isArray(output.intents) ? output.intents : [];
  const intents: ExecutionIntent[] = [];
  const minGapMs = config.runtime.agentic.minIntentGapSeconds * 1000;
  const contextByMint = new Map(contexts.map((context) => [context.token.mint, context]));

  let simulatedCash = toBigint(state.cashLamports);
  let openPositions = Object.keys(state.positions).length;

  for (const raw of rawIntents) {
    if (intents.length >= config.runtime.agentic.maxIntentsPerCycle) break;
    if (!raw || typeof raw !== "object") continue;

    const decision = raw as LlmDecision;
    const action =
      typeof decision.action === "string"
        ? decision.action.trim().toLowerCase()
        : "";
    if (action !== "buy" && action !== "sell") continue;

    const token = findTokenFromDecision(decision);
    if (!token) continue;

    const context = contextByMint.get(token.mint);
    if (!context) continue;
    if (nowMs - context.lastIntentAt < minGapMs) continue;

    const slippageBps = normalizeSlippageBps(decision.slippageBps);
    const reason =
      typeof decision.reason === "string" ? decision.reason.trim() : "";
    const confidence = clamp(
      toNumber(decision.confidence),
      0,
      1
    );

    if (action === "buy") {
      if (openPositions >= config.runtime.agentic.maxOpenPositions) continue;

      const amount = normalizeBuyLamports(decision.amountLamports, simulatedCash);
      if (amount <= 0n) continue;

      intents.push({
        type: "execution-intent",
        id: makeIntentId(token.symbol, "buy"),
        createdAt: now.toISOString(),
        expiresAt: new Date(
          nowMs + config.scanIntervalSeconds * 3000
        ).toISOString(),
        action: "buy",
        inputMint: SOL_MINT,
        outputMint: token.mint,
        amountLamports: Number(amount),
        slippageBps,
        metadata: {
          source: config.runtime.agentic.sourceTag,
          planner: "llm",
          tokenSymbol: token.symbol,
          reason,
          confidence,
          score: context.signal?.score ?? 0,
          momentum1m: context.signal?.momentum1m ?? 0,
          momentum5m: context.signal?.momentum5m ?? 0,
          volatility: context.signal?.volatility ?? 0,
        },
      });

      simulatedCash -= amount;
      openPositions++;
      state.lastIntentAt[token.mint] = nowMs;
      notes.push(
        `[LLM] BUY ${token.symbol} amount=${(
          Number(amount) / 1_000_000_000
        ).toFixed(3)} SOL${reason ? ` reason=${reason}` : ""}`
      );
      continue;
    }

    const position = context.position;
    if (!position) continue;
    const heldRaw = toBigint(position.rawAmount);
    const sellRaw = normalizeSellRaw(decision.amountLamports, heldRaw);
    if (sellRaw <= 0n) continue;

    intents.push({
      type: "execution-intent",
      id: makeIntentId(token.symbol, "sell"),
      createdAt: now.toISOString(),
      expiresAt: new Date(nowMs + config.scanIntervalSeconds * 3000).toISOString(),
      action: "sell",
      inputMint: token.mint,
      outputMint: SOL_MINT,
      amountLamports: Number(sellRaw),
      slippageBps,
      metadata: {
        source: config.runtime.agentic.sourceTag,
        planner: "llm",
        tokenSymbol: token.symbol,
        reason,
        confidence,
        pnlPct: context.pnlPct,
        holdMinutes: context.holdMinutes,
        score: context.signal?.score ?? 0,
      },
    });

    state.lastIntentAt[token.mint] = nowMs;
    notes.push(
      `[LLM] SELL ${token.symbol} amountRaw=${sellRaw.toString()}${
        reason ? ` reason=${reason}` : ""
      }`
    );
  }

  return { intents, notes };
}

export class AgenticEngine {
  private state: AgenticState | null = null;

  async init(): Promise<void> {
    this.state = await loadAgenticState();
    log.info(
      `Loaded state: cycle=${this.state.cycle}, positions=${Object.keys(
        this.state.positions
      ).length}`
    );
  }

  async save(): Promise<void> {
    if (!this.state) return;
    await saveAgenticState(this.state);
  }

  async planCycle(cycle: number): Promise<PlannedIntents> {
    if (!this.state) {
      await this.init();
    }
    const state = this.state as AgenticState;
    state.cycle = cycle;

    const now = new Date();
    const nowMs = now.getTime();

    const tokenMints = [
      SOL_MINT,
      ...config.runtime.agentic.tokenUniverse.map((token) => token.mint),
    ];

    try {
      const prices = await fetchPricesUsd(tokenMints);
      appendMarketHistory(state, prices, nowMs);
    } catch (e) {
      log.warn(`Price fetch failed: ${String(e)}`);
    }

    const contexts = buildTokenContexts(state, nowMs);
    const mode = config.runtime.agentic.plannerMode;

    if (mode === "rule") {
      return planWithRules(state, now, nowMs, contexts);
    }

    try {
      const llmContext = buildLlmPromptContext(state, now, nowMs, contexts);
      const llmOutput = await requestLlmPlan(llmContext);
      const llmPlan = sanitizeLlmPlan(llmOutput, state, now, nowMs, contexts);
      if (llmPlan.intents.length > 0 || llmPlan.notes.length > 0) {
        return llmPlan;
      }
      if (mode === "llm") {
        return { intents: [], notes: ["[LLM] No intents proposed"] };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn(`LLM planner failed: ${message}`);
      if (mode === "llm") {
        return {
          intents: [],
          notes: [`[LLM] planner failed: ${message}`],
        };
      }
    }

    const fallback = planWithRules(state, now, nowMs, contexts);
    fallback.notes.unshift("[Planner] LLM unavailable, fallback to rule planner");
    return fallback;
  }

  applyExecutionResult(intent: ExecutionIntent, result: ExecutionResult): void {
    if (!this.state) return;
    const state = this.state;

    if (result.status !== "filled") {
      state.failedCount++;
      return;
    }

    state.filledCount++;
    if (intent.action === "buy") {
      this.applyBuy(intent, result);
      return;
    }

    this.applySell(intent, result);
  }

  private applyBuy(intent: ExecutionIntent, result: ExecutionResult): void {
    if (!this.state) return;
    const state = this.state;

    const inLamports = toBigint(result.inputAmount);
    const outRaw = toBigint(result.outputAmount);
    if (inLamports <= 0n || outRaw <= 0n) return;

    const token = config.runtime.agentic.tokenUniverse.find(
      (item) => item.mint === intent.outputMint
    );
    const symbol =
      typeof intent.metadata?.tokenSymbol === "string" &&
      intent.metadata.tokenSymbol
        ? intent.metadata.tokenSymbol
        : token?.symbol ?? intent.outputMint.slice(0, 6);
    const existing = state.positions[intent.outputMint];
    const now = new Date().toISOString();

    state.positions[intent.outputMint] = existing
      ? {
          ...existing,
          rawAmount: (toBigint(existing.rawAmount) + outRaw).toString(),
          costLamports: (toBigint(existing.costLamports) + inLamports).toString(),
          updatedAt: now,
        }
      : {
          mint: intent.outputMint,
          symbol,
          decimals: token?.decimals ?? 0,
          rawAmount: outRaw.toString(),
          costLamports: inLamports.toString(),
          openedAt: now,
          updatedAt: now,
        };

    const currentCash = toBigint(state.cashLamports);
    state.cashLamports = (
      currentCash > inLamports ? currentCash - inLamports : 0n
    ).toString();
  }

  private applySell(intent: ExecutionIntent, result: ExecutionResult): void {
    if (!this.state) return;
    const state = this.state;

    const requestedRaw = toBigint(result.inputAmount);
    const outLamports = toBigint(result.outputAmount);
    if (requestedRaw <= 0n || outLamports <= 0n) return;

    const position = state.positions[intent.inputMint];
    if (!position) {
      state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
      return;
    }

    const rawAmount = toBigint(position.rawAmount);
    const costLamports = toBigint(position.costLamports);
    if (rawAmount <= 0n) {
      delete state.positions[intent.inputMint];
      state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
      return;
    }

    const soldRaw = minBigint(rawAmount, requestedRaw);
    const allocatedCost = (costLamports * soldRaw) / rawAmount;
    const pnlLamports = outLamports - allocatedCost;

    const remainingRaw = rawAmount - soldRaw;
    const remainingCost = costLamports - allocatedCost;

    if (remainingRaw <= 0n) {
      delete state.positions[intent.inputMint];
    } else {
      state.positions[intent.inputMint] = {
        ...position,
        rawAmount: remainingRaw.toString(),
        costLamports: remainingCost.toString(),
        updatedAt: new Date().toISOString(),
      };
    }

    state.cashLamports = (toBigint(state.cashLamports) + outLamports).toString();
    state.realizedPnlLamports = (
      toBigint(state.realizedPnlLamports) + pnlLamports
    ).toString();
  }

  getSummary(): string {
    if (!this.state) return "agentic state not loaded";
    const state = this.state;
    const cashSol = Number(toBigint(state.cashLamports)) / 1_000_000_000;
    const realizedSol =
      Number(toBigint(state.realizedPnlLamports)) / 1_000_000_000;
    return `cash=${cashSol.toFixed(4)} SOL, realized=${realizedSol.toFixed(
      4
    )} SOL, positions=${Object.keys(state.positions).length}, fills=${
      state.filledCount
    }, fails=${state.failedCount}`;
  }
}
