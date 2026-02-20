import { getConnection, getPublicKey, SOL_MINT } from "./wallet.js";
import { createLogger } from "../../utils/logger.js";
import type { PortfolioBalance } from "../types.js";

const log = createLogger("solana:data");

const SOL_PRICE_API = "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112";

export async function getSolPriceUsd(): Promise<number> {
  try {
    const res = await fetch(SOL_PRICE_API);
    const json = (await res.json()) as {
      data?: Record<string, { price: string }>;
    };
    if (!json.data) {
      log.warn("Jupiter API returned no data", JSON.stringify(json).slice(0, 200));
      return 0;
    }
    return Number(json.data[SOL_MINT]?.price ?? 0);
  } catch (e) {
    log.error("Failed to fetch SOL price", e);
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
      const res = await fetch(
        `https://api.jup.ag/price/v2?ids=${mints.join(",")}`
      );
      const json = (await res.json()) as {
        data: Record<string, { price: string }>;
      };
      for (const [mint, data] of Object.entries(json.data)) {
        tokenPrices[mint] = Number(data.price);
      }
    } catch (e) {
      log.warn("Failed to fetch token prices", e);
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
