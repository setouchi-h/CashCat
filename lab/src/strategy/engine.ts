import { SOL_MINT, config } from "../config/index.js";
import type { ExecutionIntent } from "../runtime/types.js";
import type { LabState, PositionState } from "../state/types.js";
import { computeMomentumSignal } from "./signal.js";

function toBigint(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function makeIntentId(symbol: string, action: "buy" | "sell", nowMs: number): string {
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString(36)
    .padStart(4, "0");
  return `lab-${nowMs}-${symbol.toLowerCase()}-${action}-${rand}`;
}

function calcBuyLamports(cashLamports: bigint, tradeAllocationPct: number, minTradeSol: number, maxTradeSol: number): bigint {
  if (cashLamports <= 0n) return 0n;

  const ppm = BigInt(Math.floor(tradeAllocationPct * 1_000_000));
  const minLamports = BigInt(Math.floor(minTradeSol * 1_000_000_000));
  const maxLamports = BigInt(Math.floor(maxTradeSol * 1_000_000_000));

  let amount = (cashLamports * ppm) / 1_000_000n;
  if (amount < minLamports) amount = minLamports;
  if (amount > maxLamports) amount = maxLamports;
  if (amount > cashLamports) amount = cashLamports;

  if (amount <= 0n || amount < minLamports) return 0n;
  return amount;
}

function calcExploreLamports(
  cashLamports: bigint,
  tradeAllocationPct: number,
  minTradeSol: number,
  maxTradeSol: number,
  tradeSizeScale: number
): bigint {
  const base = calcBuyLamports(
    cashLamports,
    tradeAllocationPct,
    minTradeSol,
    maxTradeSol
  );
  if (base <= 0n) return 0n;

  const scalePpm = BigInt(Math.max(1, Math.floor(tradeSizeScale * 1_000_000)));
  let amount = (base * scalePpm) / 1_000_000n;
  const minProbe = 10_000_000n; // 0.01 SOL
  if (amount < minProbe) amount = minProbe;
  if (amount > cashLamports) amount = cashLamports;
  return amount > 0n ? amount : 0n;
}

function calcSellRaw(rawAmount: bigint, sellFraction: number): bigint {
  if (rawAmount <= 0n) return 0n;
  if (sellFraction >= 0.999) return rawAmount;

  const ppm = BigInt(Math.max(1, Math.floor(sellFraction * 1_000_000)));
  const value = (rawAmount * ppm) / 1_000_000n;
  if (value > 0n) return value;
  return rawAmount;
}

function calcPositionPnlPct(
  position: PositionState,
  priceUsd: number,
  solPriceUsd: number
): number {
  const rawAmount = toBigint(position.rawAmount);
  const costLamports = toBigint(position.costLamports);

  if (rawAmount <= 0n || costLamports <= 0n || priceUsd <= 0 || solPriceUsd <= 0) {
    return 0;
  }

  const size = Number(rawAmount) / 10 ** position.decimals;
  const marketValueUsd = size * priceUsd;
  const costBasisUsd = (Number(costLamports) / 1_000_000_000) * solPriceUsd;

  if (costBasisUsd <= 0) return 0;
  return marketValueUsd / costBasisUsd - 1;
}

interface BuildIntentsOutput {
  intents: ExecutionIntent[];
  notes: string[];
}

export function buildIntents(state: LabState, now: Date): BuildIntentsOutput {
  const nowMs = now.getTime();
  const minGapMs = config.loop.minIntentGapSeconds * 1000;
  const solPrice = state.marketHistory[SOL_MINT]?.at(-1)?.priceUsd ?? 0;

  let simulatedCash = toBigint(state.cashLamports);
  let openPositions = Object.keys(state.positions).length;

  const intents: ExecutionIntent[] = [];
  const notes: string[] = [];
  const exploreCandidates: {
    symbol: string;
    mint: string;
    score: number;
    momentum1m: number;
    momentum5m: number;
    volatility: number;
    lastIntentAt: number;
  }[] = [];

  for (const token of config.market.tokenUniverse) {
    if (intents.length >= config.loop.maxIntentsPerCycle) break;

    const history = state.marketHistory[token.mint] ?? [];
    if (history.length < config.market.minHistoryPointsForSignal) continue;

    const signal = computeMomentumSignal(history, nowMs);
    const position = state.positions[token.mint];
    const lastIntentAt = state.lastIntentAt[token.mint] ?? 0;

    if (nowMs - lastIntentAt < minGapMs) continue;

    if (position) {
      const holdMinutes = (nowMs - Date.parse(position.openedAt)) / 60_000;
      const pnlPct = calcPositionPnlPct(
        position,
        history.at(-1)?.priceUsd ?? 0,
        solPrice
      );
      const shouldSell =
        signal.score <= state.policy.sellMomentumThreshold ||
        pnlPct >= state.policy.takeProfitPct ||
        pnlPct <= state.policy.stopLossPct ||
        holdMinutes >= state.policy.maxHoldMinutes;

      if (!shouldSell) continue;

      const rawAmount = toBigint(position.rawAmount);
      const sellRaw = calcSellRaw(rawAmount, state.policy.sellFraction);
      if (sellRaw <= 0n) continue;

      const id = makeIntentId(token.symbol, "sell", nowMs);
      intents.push({
        type: "execution-intent",
        id,
        createdAt: now.toISOString(),
        expiresAt: new Date(nowMs + config.loop.intervalSeconds * 3000).toISOString(),
        action: "sell",
        inputMint: token.mint,
        outputMint: SOL_MINT,
        amountLamports: Number(sellRaw),
        slippageBps: state.policy.intentSlippageBps,
        metadata: {
          tokenSymbol: token.symbol,
          source: "lab-momentum",
          score: signal.score,
          pnlPct,
          holdMinutes,
        },
      });

      state.lastIntentAt[token.mint] = nowMs;
      notes.push(
        `SELL ${token.symbol} score=${signal.score.toFixed(4)} pnl=${(pnlPct * 100).toFixed(2)}%`
      );
      continue;
    }

    exploreCandidates.push({
      symbol: token.symbol,
      mint: token.mint,
      score: signal.score,
      momentum1m: signal.momentum1m,
      momentum5m: signal.momentum5m,
      volatility: signal.volatility,
      lastIntentAt,
    });

    if (openPositions >= state.policy.maxOpenPositions) continue;
    if (signal.score < state.policy.buyMomentumThreshold) continue;

    const buyLamports = calcBuyLamports(
      simulatedCash,
      state.policy.tradeAllocationPct,
      state.policy.minTradeSol,
      state.policy.maxTradeSol
    );
    if (buyLamports <= 0n) continue;

    const id = makeIntentId(token.symbol, "buy", nowMs);
    intents.push({
      type: "execution-intent",
      id,
      createdAt: now.toISOString(),
      expiresAt: new Date(nowMs + config.loop.intervalSeconds * 3000).toISOString(),
      action: "buy",
      inputMint: SOL_MINT,
      outputMint: token.mint,
      amountLamports: Number(buyLamports),
      slippageBps: state.policy.intentSlippageBps,
      metadata: {
        tokenSymbol: token.symbol,
        source: "lab-momentum",
        score: signal.score,
        momentum1m: signal.momentum1m,
        momentum5m: signal.momentum5m,
        volatility: signal.volatility,
      },
    });

    simulatedCash -= buyLamports;
    openPositions++;
    state.lastIntentAt[token.mint] = nowMs;
    notes.push(
      `BUY ${token.symbol} score=${signal.score.toFixed(4)} amount=${(
        Number(buyLamports) / 1_000_000_000
      ).toFixed(3)} SOL`
    );
  }

  if (
    intents.length === 0 &&
    openPositions === 0 &&
    config.strategy.explore.enabled &&
    state.cycle % config.strategy.explore.everyCycles === 0
  ) {
    const candidate = exploreCandidates
      .filter((c) => nowMs - c.lastIntentAt >= minGapMs)
      .sort((a, b) => b.score - a.score)[0];

    if (candidate && candidate.score >= config.strategy.explore.minScore) {
      const buyLamports = calcExploreLamports(
        simulatedCash,
        state.policy.tradeAllocationPct,
        state.policy.minTradeSol,
        state.policy.maxTradeSol,
        config.strategy.explore.tradeSizeScale
      );

      if (buyLamports > 0n) {
        const id = makeIntentId(candidate.symbol, "buy", nowMs);
        intents.push({
          type: "execution-intent",
          id,
          createdAt: now.toISOString(),
          expiresAt: new Date(nowMs + config.loop.intervalSeconds * 3000).toISOString(),
          action: "buy",
          inputMint: SOL_MINT,
          outputMint: candidate.mint,
          amountLamports: Number(buyLamports),
          slippageBps: state.policy.intentSlippageBps,
          metadata: {
            tokenSymbol: candidate.symbol,
            source: "lab-explore",
            explore: true,
            score: candidate.score,
            momentum1m: candidate.momentum1m,
            momentum5m: candidate.momentum5m,
            volatility: candidate.volatility,
          },
        });
        state.lastIntentAt[candidate.mint] = nowMs;
        notes.push(
          `EXPLORE BUY ${candidate.symbol} score=${candidate.score.toFixed(4)} amount=${(
            Number(buyLamports) / 1_000_000_000
          ).toFixed(3)} SOL`
        );
      }
    }
  }

  return {
    intents,
    notes,
  };
}
