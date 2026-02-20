export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  marketCap?: number;
}

export interface MarketData {
  token: TokenInfo;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: number;
  volume24h: number;
  liquidity: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  txns24h: { buys: number; sells: number };
}

export interface PortfolioBalance {
  nativeBalance: number;
  nativeValueUsd: number;
  tokens: {
    address: string;
    symbol: string;
    balance: number;
    valueUsd: number;
  }[];
  totalValueUsd: number;
}

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  slippageBps: number;
  quoteResponse?: unknown;
}

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
  error?: string;
}

export interface ChainPlugin {
  name: string;
  getMarketData(): Promise<MarketData[]>;
  getTrendingTokens(): Promise<TokenInfo[]>;
  getBalance(): Promise<PortfolioBalance>;
  executeTrade(trade: TradeOrder): Promise<TradeResult>;
  getSwapQuote(params: SwapParams): Promise<SwapQuote>;
}
