import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { TradeOrder, TradeResult } from "../types.js";
import { SOL_MINT, getConnection } from "./wallet.js";
import { getSolPriceUsd } from "./data.js";

const PAPER_INITIAL_SOL = 10;

interface PaperPosition {
  rawAmount: bigint;
  costLamports: bigint;
}

export class PaperPortfolio {
  private solLamports = BigInt(PAPER_INITIAL_SOL * LAMPORTS_PER_SOL);
  private positions = new Map<string, PaperPosition>();
  private mintDecimals = new Map<string, number>();

  getSolLamports(): bigint {
    return this.solLamports;
  }

  getTokenRawBalance(mint: string): bigint {
    return this.positions.get(mint)?.rawAmount ?? 0n;
  }

  async applyTrade(order: TradeOrder, result: TradeResult): Promise<number | undefined> {
    const inAmount = toBigInt(result.inputAmount);
    const outAmount = toBigInt(result.outputAmount);
    if (inAmount <= 0n && outAmount <= 0n) return undefined;

    if (order.action === "buy") {
      await this.ensureMintDecimals(order.outputMint);
      const current = this.positions.get(order.outputMint) ?? {
        rawAmount: 0n,
        costLamports: 0n,
      };
      current.rawAmount += outAmount;
      current.costLamports += inAmount;
      this.positions.set(order.outputMint, current);
      this.solLamports = this.solLamports > inAmount ? this.solLamports - inAmount : 0n;
      return undefined;
    }

    await this.ensureMintDecimals(order.inputMint);
    const current = this.positions.get(order.inputMint);
    if (!current || current.rawAmount <= 0n) return 0;

    const sold = inAmount > current.rawAmount ? current.rawAmount : inAmount;
    if (sold <= 0n) return 0;

    const allocatedCost =
      current.costLamports > 0n
        ? (current.costLamports * sold) / current.rawAmount
        : 0n;
    const pnlLamports = outAmount - allocatedCost;

    current.rawAmount -= sold;
    current.costLamports -= allocatedCost;
    if (current.rawAmount <= 0n) {
      this.positions.delete(order.inputMint);
    } else {
      this.positions.set(order.inputMint, current);
    }

    this.solLamports += outAmount;

    const solPrice = await getSolPriceUsd();
    return (Number(pnlLamports) / LAMPORTS_PER_SOL) * solPrice;
  }

  async ensureMintDecimals(mint: string): Promise<number> {
    if (mint === SOL_MINT) return 9;
    const cached = this.mintDecimals.get(mint);
    if (cached !== undefined) return cached;

    const decimals = await fetchMintDecimals(mint);
    this.mintDecimals.set(mint, decimals);
    return decimals;
  }
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

async function fetchMintDecimals(mint: string): Promise<number> {
  try {
    const conn = getConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const value = info.value;
    if (!value || !("data" in value)) return 0;
    const data = value.data as
      | { parsed?: { info?: { decimals?: number } } }
      | Buffer;
    if (Buffer.isBuffer(data)) return 0;
    const decimals = data.parsed?.info?.decimals;
    return typeof decimals === "number" ? decimals : 0;
  } catch {
    return 0;
  }
}
