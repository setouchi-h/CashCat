import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import type {
  ExecutionIntent,
  ExecutionResult,
  ImprovementProposal,
  ImprovementVerdict,
  RuntimeQueueItem,
} from "./types.js";

const log = createLogger("runtime:bridge");

export async function prepareRuntimeDirs(): Promise<void> {
  await Promise.all([
    ensureDir(config.runtime.intentDir),
    ensureDir(config.runtime.resultDir),
    ensureDir(config.runtime.proposalDir),
    ensureDir(config.runtime.verdictDir),
    ensureDir(path.join(config.runtime.intentDir, "_processing")),
    ensureDir(path.join(config.runtime.intentDir, "_processed")),
    ensureDir(path.join(config.runtime.proposalDir, "_processing")),
    ensureDir(path.join(config.runtime.proposalDir, "_processed")),
  ]);
}

export async function triggerRuntimeAutoRun(cycle: number): Promise<void> {
  const command = config.runtime.autoRunCommand.trim();
  if (!command) return;

  const cwd = config.runtime.autoRunCwd.trim() || process.cwd();
  const timeoutMs = Math.max(5, config.runtime.commandTimeoutSeconds) * 1000;

  await new Promise<void>((resolve) => {
    const child = spawn("zsh", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        CASHCAT_CYCLE: String(cycle),
        CASHCAT_INTENT_DIR: config.runtime.intentDir,
        CASHCAT_RESULT_DIR: config.runtime.resultDir,
        CASHCAT_PROPOSAL_DIR: config.runtime.proposalDir,
        CASHCAT_VERDICT_DIR: config.runtime.verdictDir,
      },
      stdio: "pipe",
    });

    let done = false;
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      log.warn(`Runtime auto command timed out: ${command}`);
      resolve();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) {
        log.info(`Runtime auto command succeeded: ${command}`);
      } else {
        log.warn(`Runtime auto command failed (exit=${code}): ${command}`);
      }
      if (stdout.trim()) log.info(`[Auto stdout] ${truncate(stdout, 400)}`);
      if (stderr.trim()) log.warn(`[Auto stderr] ${truncate(stderr, 400)}`);
      resolve();
    });

    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      log.warn(`Runtime auto command spawn failed: ${command}`, e);
      resolve();
    });
  });
}

export async function consumeExecutionIntents(
  limit: number
): Promise<RuntimeQueueItem<ExecutionIntent>[]> {
  return consumeQueueItems(
    config.runtime.intentDir,
    ".intent.json",
    limit,
    parseExecutionIntent
  );
}

export async function writeExecutionIntent(
  intent: ExecutionIntent
): Promise<string> {
  await ensureDir(config.runtime.intentDir);
  const filePath = path.join(
    config.runtime.intentDir,
    `${Date.now()}.${process.pid}.${intent.id}.intent.json`
  );
  const tempPath = filePath + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(intent, null, 2));
  await fs.rename(tempPath, filePath);
  return filePath;
}

export async function consumeImprovementProposals(
  limit: number
): Promise<RuntimeQueueItem<ImprovementProposal>[]> {
  return consumeQueueItems(
    config.runtime.proposalDir,
    ".proposal.json",
    limit,
    parseImprovementProposal
  );
}

export async function archiveConsumedItem(
  filePath: string,
  status: string
): Promise<void> {
  const sourceDir = path.dirname(path.dirname(filePath));
  const processedDir = path.join(sourceDir, "_processed");
  await ensureDir(processedDir);

  const base = path.basename(filePath, ".json");
  const next = path.join(processedDir, `${base}.${status}.json`);
  await fs.rename(filePath, next).catch(async () => {
    const body = await fs.readFile(filePath, "utf8").catch(() => "");
    if (body) await fs.writeFile(next, body);
    await fs.unlink(filePath).catch(() => {});
  });
}

export async function writeExecutionResult(result: ExecutionResult): Promise<string> {
  await ensureDir(config.runtime.resultDir);
  const filePath = path.join(
    config.runtime.resultDir,
    `${result.intentId}.${Date.now()}.result.json`
  );
  await fs.writeFile(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

export async function writeImprovementVerdict(
  verdict: ImprovementVerdict
): Promise<string> {
  await ensureDir(config.runtime.verdictDir);
  const filePath = path.join(
    config.runtime.verdictDir,
    `${verdict.proposalId}.${Date.now()}.verdict.json`
  );
  await fs.writeFile(filePath, JSON.stringify(verdict, null, 2));
  return filePath;
}

async function consumeQueueItems<T>(
  queueDir: string,
  suffix: string,
  limit: number,
  parser: (raw: string) => T | null
): Promise<RuntimeQueueItem<T>[]> {
  await ensureDir(queueDir);
  await ensureDir(path.join(queueDir, "_processing"));
  await ensureDir(path.join(queueDir, "_processed"));

  const entries = (await fs.readdir(queueDir))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .slice(0, Math.max(0, limit));

  const items: RuntimeQueueItem<T>[] = [];

  for (const name of entries) {
    const src = path.join(queueDir, name);
    const processing = path.join(queueDir, "_processing", name);

    const claimed = await claimFile(src, processing);
    if (!claimed) continue;

    const raw = await fs.readFile(processing, "utf8").catch(() => "");
    if (!raw) {
      await archiveConsumedItem(processing, "empty");
      continue;
    }

    const payload = parser(raw);
    if (!payload) {
      await archiveConsumedItem(processing, "invalid");
      continue;
    }

    items.push({ payload, filePath: processing });
  }

  return items;
}

function parseExecutionIntent(raw: string): ExecutionIntent | null {
  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      id?: unknown;
      createdAt?: unknown;
      expiresAt?: unknown;
      action?: unknown;
      inputMint?: unknown;
      outputMint?: unknown;
      amountLamports?: unknown;
      slippageBps?: unknown;
      metadata?: unknown;
    };

    if (parsed.type !== "execution-intent") return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (parsed.action !== "buy" && parsed.action !== "sell") return null;
    if (typeof parsed.inputMint !== "string" || !parsed.inputMint) return null;
    if (typeof parsed.outputMint !== "string" || !parsed.outputMint) return null;

    const amount =
      typeof parsed.amountLamports === "number"
        ? parsed.amountLamports
        : Number(parsed.amountLamports);
    const slippage =
      typeof parsed.slippageBps === "number"
        ? parsed.slippageBps
        : Number(parsed.slippageBps);

    if (!Number.isFinite(amount) || !Number.isFinite(slippage)) return null;

    return {
      type: "execution-intent",
      id: parsed.id,
      createdAt:
        typeof parsed.createdAt === "string" && parsed.createdAt
          ? parsed.createdAt
          : new Date().toISOString(),
      expiresAt:
        typeof parsed.expiresAt === "string" ? parsed.expiresAt : undefined,
      action: parsed.action,
      inputMint: parsed.inputMint,
      outputMint: parsed.outputMint,
      amountLamports: Math.floor(amount),
      slippageBps: Math.floor(slippage),
      metadata:
        parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return null;
  }
}

function parseImprovementProposal(raw: string): ImprovementProposal | null {
  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      id?: unknown;
      createdAt?: unknown;
      candidateId?: unknown;
      metrics?: unknown;
      artifacts?: unknown;
      notes?: unknown;
    };

    if (parsed.type !== "improvement-proposal") return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.candidateId !== "string" || !parsed.candidateId) return null;
    if (!parsed.metrics || typeof parsed.metrics !== "object") return null;

    const metrics = parsed.metrics as {
      pnlDeltaPct?: unknown;
      sharpeDelta?: unknown;
      maxDrawdownDeltaPct?: unknown;
      testPassRate?: unknown;
    };

    const pnlDelta = Number(metrics.pnlDeltaPct);
    const sharpeDelta = Number(metrics.sharpeDelta);
    const drawdownDelta = Number(metrics.maxDrawdownDeltaPct);
    const passRate = Number(metrics.testPassRate);

    if (
      !Number.isFinite(pnlDelta) ||
      !Number.isFinite(sharpeDelta) ||
      !Number.isFinite(drawdownDelta) ||
      !Number.isFinite(passRate)
    ) {
      return null;
    }

    return {
      type: "improvement-proposal",
      id: parsed.id,
      createdAt:
        typeof parsed.createdAt === "string" && parsed.createdAt
          ? parsed.createdAt
          : new Date().toISOString(),
      candidateId: parsed.candidateId,
      metrics: {
        pnlDeltaPct: pnlDelta,
        sharpeDelta,
        maxDrawdownDeltaPct: drawdownDelta,
        testPassRate: passRate,
      },
      artifacts:
        parsed.artifacts && typeof parsed.artifacts === "object"
          ? (parsed.artifacts as { reportRef?: string; patchRef?: string })
          : undefined,
      notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
    };
  } catch {
    return null;
  }
}

async function claimFile(src: string, dst: string): Promise<boolean> {
  try {
    await fs.rename(src, dst);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : clean.slice(0, max) + "...";
}
