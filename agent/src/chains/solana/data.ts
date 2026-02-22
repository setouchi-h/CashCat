import { SOL_MINT } from "./wallet.js";
import { createLogger } from "../../utils/logger.js";
import { config } from "../../config/index.js";

const log = createLogger("solana:data");

function buildJupiterPriceUrl(ids: string[]): string {
  const url = new URL(`${config.jupiter.baseUrl}/price/v3`);
  url.searchParams.set("ids", ids.join(","));
  return url.toString();
}

async function fetchJupiterPrices(ids: string[]): Promise<Record<string, number>> {
  const res = await fetch(buildJupiterPriceUrl(ids));

  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`status=${res.status} body=${text}`);
  }

  const json = (await res.json()) as {
    [mint: string]: {
      usdPrice?: number;
    } | undefined;
  };

  const keys = Object.keys(json);
  if (keys.length === 0) {
    throw new Error("missing data field");
  }

  const prices: Record<string, number> = {};
  for (const mint of ids) {
    prices[mint] = Number(json[mint]?.usdPrice ?? 0);
  }
  return prices;
}

export async function getSolPriceUsd(): Promise<number> {
  try {
    const prices = await fetchJupiterPrices([SOL_MINT]);
    return prices[SOL_MINT] ?? 0;
  } catch (e) {
    log.warn(
      `Failed to fetch SOL price from Jupiter (${config.jupiter.baseUrl}). ${String(e)}`
    );
    return 0;
  }
}
