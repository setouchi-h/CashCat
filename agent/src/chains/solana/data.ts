import { getConnection, getPublicKey, SOL_MINT } from "./wallet.js";
import { createLogger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import type { PortfolioBalance } from "../types.js";

const log = createLogger("solana:data");

function getJupiterHeaders(): HeadersInit | undefined {
  if (!config.jupiter.apiKey) return undefined;
  return { "x-api-key": config.jupiter.apiKey };
}

function buildJupiterPriceUrl(ids: string[]): string {
  const url = new URL(`${config.jupiter.baseUrl}/price/v3`);
  url.searchParams.set("ids", ids.join(","));
  return url.toString();
}

async function fetchJupiterPrices(
  ids: string[]
): Promise<Record<string, number>> {
  const res = await fetch(buildJupiterPriceUrl(ids), {
    headers: getJupiterHeaders(),
  });

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

export async function getTokenAccounts(): Promise<
  { mint: string; amount: number; decimals: number }[]
> {
  const conn = getConnection();
  const pubkey = getPublicKey();

  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
    programId: new (await import("@solana/web3.js")).PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    ),
  });

  return tokenAccounts.value.map((ta) => {
    const info = ta.account.data.parsed.info;
    return {
      mint: info.mint as string,
      amount: Number(info.tokenAmount.uiAmount),
      decimals: Number(info.tokenAmount.decimals),
    };
  });
}

export async function getPortfolioBalance(): Promise<PortfolioBalance> {
  const conn = getConnection();
  const pubkey = getPublicKey();

  const [lamports, solPrice, tokenAccounts] = await Promise.all([
    conn.getBalance(pubkey),
    getSolPriceUsd(),
    getTokenAccounts(),
  ]);

  const solBalance = lamports / 1e9;
  const solValueUsd = solBalance * solPrice;

  // Get prices for held tokens via Jupiter
  const mints = tokenAccounts
    .filter((t) => t.amount > 0)
    .map((t) => t.mint);

  let tokenPrices: Record<string, number> = {};
  if (mints.length > 0) {
    try {
      tokenPrices = await fetchJupiterPrices(mints);
    } catch (e) {
      log.warn(
        `Failed to fetch token prices from Jupiter (${config.jupiter.baseUrl}). ${String(e)}`
      );
    }
  }

  const tokens = tokenAccounts
    .filter((t) => t.amount > 0)
    .map((t) => ({
      address: t.mint,
      symbol: t.mint.slice(0, 6),
      balance: t.amount,
      valueUsd: t.amount * (tokenPrices[t.mint] ?? 0),
    }));

  const totalValueUsd =
    solValueUsd + tokens.reduce((sum, t) => sum + t.valueUsd, 0);

  log.info(`Portfolio: ${solBalance.toFixed(4)} SOL ($${solValueUsd.toFixed(2)}), ${tokens.length} tokens, total $${totalValueUsd.toFixed(2)}`);

  return {
    nativeBalance: solBalance,
    nativeValueUsd: solValueUsd,
    tokens,
    totalValueUsd,
  };
}
