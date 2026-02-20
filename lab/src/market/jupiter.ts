import { config } from "../config/index.js";

function getHeaders(): HeadersInit | undefined {
  if (!config.market.jupiterApiKey) return undefined;
  return { "x-api-key": config.market.jupiterApiKey };
}

function buildPriceUrl(mints: string[]): string {
  const url = new URL(`${config.market.jupiterBaseUrl}/price/v3`);
  url.searchParams.set("ids", mints.join(","));
  return url.toString();
}

export async function fetchPricesUsd(
  mints: string[]
): Promise<Record<string, number>> {
  if (mints.length === 0) return {};

  const response = await fetch(buildPriceUrl(mints), {
    headers: getHeaders(),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`Jupiter price failed: ${response.status} ${body}`);
  }

  const json = (await response.json()) as Record<
    string,
    { usdPrice?: number } | undefined
  >;

  const prices: Record<string, number> = {};
  for (const mint of mints) {
    prices[mint] = Number(json[mint]?.usdPrice ?? 0);
  }
  return prices;
}
