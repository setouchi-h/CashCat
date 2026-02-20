export interface TradeOrder {
  action: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
}

export interface TradeResult {
  success: boolean;
  txHash?: string;
  inputAmount: string;
  outputAmount: string;
  pnlUsd?: number;
  error?: string;
}

export interface ChainPlugin {
  name: string;
  executeTrade(trade: TradeOrder): Promise<TradeResult>;
}
