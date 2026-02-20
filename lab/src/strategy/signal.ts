export interface SignalPoint {
  ts: number;
  priceUsd: number;
}

export interface MomentumSignal {
  score: number;
  momentum1m: number;
  momentum5m: number;
  volatility: number;
}

function findPriceAtOrBefore(points: SignalPoint[], targetTs: number): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].ts <= targetTs) return points[i].priceUsd;
  }
  return null;
}

function calcReturn(current: number, prev: number | null): number {
  if (!prev || prev <= 0 || current <= 0) return 0;
  return current / prev - 1;
}

function calcVolatility(points: SignalPoint[], sampleSize: number): number {
  if (points.length < 3) return 0;

  const returns: number[] = [];
  const start = Math.max(1, points.length - sampleSize);
  for (let i = start; i < points.length; i++) {
    const prev = points[i - 1].priceUsd;
    const cur = points[i].priceUsd;
    if (prev > 0 && cur > 0) {
      returns.push(cur / prev - 1);
    }
  }

  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, v) => sum + v, 0) / returns.length;
  const variance =
    returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / returns.length;
  return Math.sqrt(Math.max(0, variance));
}

export function computeMomentumSignal(
  points: SignalPoint[],
  nowTs: number
): MomentumSignal {
  const last = points[points.length - 1]?.priceUsd ?? 0;
  if (last <= 0) {
    return {
      score: 0,
      momentum1m: 0,
      momentum5m: 0,
      volatility: 0,
    };
  }

  const price1m = findPriceAtOrBefore(points, nowTs - 60_000);
  const price5m = findPriceAtOrBefore(points, nowTs - 300_000);
  const momentum1m = calcReturn(last, price1m);
  const momentum5m = calcReturn(last, price5m);
  const volatility = calcVolatility(points, 30);

  return {
    score: momentum1m * 0.7 + momentum5m * 0.3,
    momentum1m,
    momentum5m,
    volatility,
  };
}
