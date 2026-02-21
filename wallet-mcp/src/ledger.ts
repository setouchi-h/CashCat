import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface LedgerEvent {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export async function appendLedgerEvent(
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const event: LedgerEvent = {
    timestamp: new Date().toISOString(),
    type,
    payload,
  };

  const ledgerPath = config.ledger.path;
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, JSON.stringify(event) + "\n", "utf8");
}
