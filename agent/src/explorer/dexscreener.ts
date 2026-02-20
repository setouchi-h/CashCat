import { createLogger } from "../utils/logger.js";
import type { MarketData, TokenInfo } from "../chains/types.js";

const log = createLogger("dexscreener");

const BASE_URL = "https://api.dexscreener.com";

interface DexScreenerPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd: string;
  volume: { h24: number };
  liquidity: { usd: number };
  priceChange: { m5: number; h1: number; h24: number };
  txns: { h24: { buys: number; sells: number } };
  fdv: number;
}

function pairToMarketData(pair: DexScreenerPair): MarketData {
  const token: TokenInfo = {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    decimals: 0, // DexScreener doesn't expose this
    priceUsd: Number(pair.priceUsd),
    priceChange24h: pair.priceChange?.h24 ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    liquidity: pair.liquidity?.usd ?? 0,
    marketCap: pair.fdv,
  };

  return {
    token,
    pairAddress: pair.pairAddress,
    baseToken: { address: pair.baseToken.address, symbol: pair.baseToken.symbol },
    quoteToken: { address: pair.quoteToken.address, symbol: pair.quoteToken.symbol },
    priceUsd: Number(pair.priceUsd),
    volume24h: pair.volume?.h24 ?? 0,
    liquidity: pair.liquidity?.usd ?? 0,
    priceChange5m: pair.priceChange?.m5 ?? 0,
    priceChange1h: pair.priceChange?.h1 ?? 0,
    priceChange24h: pair.priceChange?.h24 ?? 0,
    txns24h: pair.txns?.h24 ?? { buys: 0, sells: 0 },
  };
}

export async function fetchDexScreenerSolana(): Promise<MarketData[]> {
  try {
    const res = await fetch(
      `${BASE_URL}/token-profiles/latest/v1`,
      { headers: { Accept: "application/json" } }
    );

    if (!res.ok) {
      log.warn(`DexScreener token profiles returned ${res.status}, falling back to search`);
      return fetchDexScreenerSolanaSearch();
    }

    // Use search endpoint for Solana trending pairs
    return fetchDexScreenerSolanaSearch();
  } catch (e) {
    log.error("DexScreener fetch failed", e);
    return [];
  }
}

async function fetchDexScreenerSolanaSearch(): Promise<MarketData[]> {
  try {
    // Fetch top Solana pairs by volume
    const res = await fetch(
      `${BASE_URL}/latest/dex/search?q=SOL&chain=solana`,
      { headers: { Accept: "application/json" } }
    );

    if (!res.ok) {
      throw new Error(`DexScreener search returned ${res.status}`);
    }

    const json = (await res.json()) as { pairs: DexScreenerPair[] };
    const pairs = json.pairs ?? [];

    const solanaPairs = pairs.filter((p) => p.chainId === "solana");

    log.info(`Fetched ${solanaPairs.length} Solana pairs from DexScreener`);

    return solanaPairs.map(pairToMarketData);
  } catch (e) {
    log.error("DexScreener search failed", e);
    return [];
  }
}

export async function searchToken(query: string): Promise<MarketData[]> {
  try {
    const res = await fetch(
      `${BASE_URL}/latest/dex/search?q=${encodeURIComponent(query)}`,
      { headers: { Accept: "application/json" } }
    );

    if (!res.ok) {
      throw new Error(`DexScreener search returned ${res.status}`);
    }

    const json = (await res.json()) as { pairs: DexScreenerPair[] };
    return (json.pairs ?? [])
      .filter((p) => p.chainId === "solana")
      .map(pairToMarketData);
  } catch (e) {
    log.error(`Token search failed for "${query}"`, e);
    return [];
  }
}
