import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import type {
  ExecutionIntent,
  ExecutionResult,
  ImprovementProposal,
  ImprovementVerdict,
} from "./types.js";

export async function ensureRuntimeDirs(): Promise<void> {
  await Promise.all([
    fs.mkdir(config.runtime.intentDir, { recursive: true }),
    fs.mkdir(config.runtime.resultDir, { recursive: true }),
    fs.mkdir(config.runtime.proposalDir, { recursive: true }),
    fs.mkdir(config.runtime.verdictDir, { recursive: true }),
  ]);
}

export async function writeIntent(intent: ExecutionIntent): Promise<string> {
  await fs.mkdir(config.runtime.intentDir, { recursive: true });
  const filePath = path.join(config.runtime.intentDir, `${intent.id}.intent.json`);
  await fs.writeFile(filePath, JSON.stringify(intent, null, 2));
  return filePath;
}

export async function writeProposal(
  proposal: ImprovementProposal
): Promise<string> {
  await fs.mkdir(config.runtime.proposalDir, { recursive: true });
  const filePath = path.join(
    config.runtime.proposalDir,
    `${proposal.id}.proposal.json`
  );
  await fs.writeFile(filePath, JSON.stringify(proposal, null, 2));
  return filePath;
}

export async function readExecutionResults(
  processed: Set<string>
): Promise<{ name: string; payload: ExecutionResult }[]> {
  const files = (await fs.readdir(config.runtime.resultDir).catch(() => []))
    .filter((name) => name.endsWith(".result.json"))
    .sort();

  const items: { name: string; payload: ExecutionResult }[] = [];
  for (const name of files) {
    if (processed.has(name)) continue;
    const filePath = path.join(config.runtime.resultDir, name);
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw) continue;

    try {
      const payload = JSON.parse(raw) as ExecutionResult;
      if (payload.type !== "execution-result") continue;
      items.push({ name, payload });
    } catch {
      continue;
    }
  }

  return items;
}

export async function readVerdicts(
  processed: Set<string>
): Promise<{ name: string; payload: ImprovementVerdict }[]> {
  const files = (await fs.readdir(config.runtime.verdictDir).catch(() => []))
    .filter((name) => name.endsWith(".verdict.json"))
    .sort();

  const items: { name: string; payload: ImprovementVerdict }[] = [];
  for (const name of files) {
    if (processed.has(name)) continue;
    const filePath = path.join(config.runtime.verdictDir, name);
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw) continue;

    try {
      const payload = JSON.parse(raw) as ImprovementVerdict;
      if (payload.type !== "improvement-verdict") continue;
      items.push({ name, payload });
    } catch {
      continue;
    }
  }

  return items;
}
