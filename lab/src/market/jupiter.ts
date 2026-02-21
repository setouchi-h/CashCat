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

function toNumber(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(num) ? num : 0;
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
