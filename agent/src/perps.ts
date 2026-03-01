import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  DriftClient,
  getMarketOrderParams,
  PositionDirection,
  BASE_PRECISION,
  PRICE_PRECISION,
  initialize,
  type DriftClientConfig,
} from "@drift-labs/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// USDC Constants
// ---------------------------------------------------------------------------

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_SPOT_MARKET_INDEX = 0;
const USDC_DECIMALS = 6;

const log = createLogger("perps");

// ---------------------------------------------------------------------------
// Drift Market Registry
// ---------------------------------------------------------------------------

interface DriftMarketInfo {
  marketIndex: number;
  symbol: string;
  underlyingMint: string;
}

const DRIFT_MARKETS: Map<string, DriftMarketInfo> = new Map([
  ["SOL-PERP", { marketIndex: 0, symbol: "SOL-PERP", underlyingMint: "So11111111111111111111111111111111111111112" }],
  ["BTC-PERP", { marketIndex: 1, symbol: "BTC-PERP", underlyingMint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh" }],
  ["ETH-PERP", { marketIndex: 2, symbol: "ETH-PERP", underlyingMint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" }],
  ["1MBONK-PERP", { marketIndex: 4, symbol: "1MBONK-PERP", underlyingMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" }],
  ["1MPEPE-PERP", { marketIndex: 5, symbol: "1MPEPE-PERP", underlyingMint: "HRQke5DKdDo3jV7ja6Vs9eqrzMFqiGuMsTCCTUBCUdax" }],
  ["1MWEN-PERP", { marketIndex: 9, symbol: "1MWEN-PERP", underlyingMint: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk" }],
  ["W-PERP", { marketIndex: 13, symbol: "W-PERP", underlyingMint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ" }],
  ["TNSR-PERP", { marketIndex: 14, symbol: "TNSR-PERP", underlyingMint: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6" }],
  ["JTO-PERP", { marketIndex: 15, symbol: "JTO-PERP", underlyingMint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" }],
  ["WIF-PERP", { marketIndex: 23, symbol: "WIF-PERP", underlyingMint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" }],
  ["JUP-PERP", { marketIndex: 24, symbol: "JUP-PERP", underlyingMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }],
  ["RENDER-PERP", { marketIndex: 26, symbol: "RENDER-PERP", underlyingMint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof" }],
  ["PYTH-PERP", { marketIndex: 28, symbol: "PYTH-PERP", underlyingMint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" }],
  ["HNT-PERP", { marketIndex: 29, symbol: "HNT-PERP", underlyingMint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux" }],
  ["INJ-PERP", { marketIndex: 32, symbol: "INJ-PERP", underlyingMint: "6McPRfPV6bY1e9hLxWyG54W9i9Epq75QBvXg2oetBVTB" }],
  ["ORCA-PERP", { marketIndex: 36, symbol: "ORCA-PERP", underlyingMint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE" }],
  ["PENGU-PERP", { marketIndex: 42, symbol: "PENGU-PERP", underlyingMint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv" }],
  ["AI16Z-PERP", { marketIndex: 48, symbol: "AI16Z-PERP", underlyingMint: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC" }],
  ["TRUMP-PERP", { marketIndex: 50, symbol: "TRUMP-PERP", underlyingMint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN" }],
  ["MELANIA-PERP", { marketIndex: 52, symbol: "MELANIA-PERP", underlyingMint: "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P" }],
  ["VINE-PERP", { marketIndex: 55, symbol: "VINE-PERP", underlyingMint: "6AJcP7wuLwmRYLBNbi825wgguaPsWzPBEHcHndpRpump" }],
]);

// Alias map: common name → canonical Drift name
const MARKET_ALIASES: Record<string, string> = {
  "BONK-PERP": "1MBONK-PERP",
  "PEPE-PERP": "1MPEPE-PERP",
  "WEN-PERP": "1MWEN-PERP",
};

export function getDriftMarket(name: string): DriftMarketInfo | null {
  const upper = name.trim().toUpperCase();
  const canonical = MARKET_ALIASES[upper] ?? upper;
  return DRIFT_MARKETS.get(canonical) ?? null;
}

export function resolveMarketName(name: string): string {
  const upper = name.trim().toUpperCase();
  return MARKET_ALIASES[upper] ?? upper;
}

export function getAvailableMarkets(): DriftMarketInfo[] {
  return Array.from(DRIFT_MARKETS.values());
}

// ---------------------------------------------------------------------------
// ReadOnly Wallet (satisfies Anchor Wallet interface for read-only DriftClient)
// ---------------------------------------------------------------------------

class ReadOnlyWallet {
  readonly publicKey: PublicKey;
  readonly payer: Keypair;

  constructor(pubkey: PublicKey) {
    this.publicKey = pubkey;
    // Dummy keypair — we never actually sign with it
    this.payer = Keypair.generate();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTransaction(tx: any): Promise<any> {
    throw new Error("ReadOnlyWallet cannot sign transactions");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signAllTransactions(txs: any[]): Promise<any[]> {
    throw new Error("ReadOnlyWallet cannot sign transactions");
  }
}

// ---------------------------------------------------------------------------
// DriftClient singleton (lazy init)
// ---------------------------------------------------------------------------

let cachedDriftClient: DriftClient | null = null;
let cachedWalletPubkey: string | null = null;

function getRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
}

function getConnection(): Connection {
  return new Connection(getRpcUrl(), "confirmed");
}

async function createReadOnlyDriftClient(walletPubkey: PublicKey): Promise<DriftClient> {
  const pubkeyStr = walletPubkey.toBase58();

  if (cachedDriftClient && cachedWalletPubkey === pubkeyStr) {
    return cachedDriftClient;
  }

  // Clean up previous client
  if (cachedDriftClient) {
    try {
      await cachedDriftClient.unsubscribe();
    } catch {
      // ignore cleanup errors
    }
    cachedDriftClient = null;
    cachedWalletPubkey = null;
  }

  const connection = getConnection();
  const wallet = new ReadOnlyWallet(walletPubkey);

  const sdkConfig = initialize({
    env: config.perps.driftEnv as "mainnet-beta" | "devnet",
  });

  const driftConfig: DriftClientConfig = {
    connection: connection as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- web3.js version mismatch
    wallet: wallet as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    accountSubscription: {
      type: "websocket",
    },
    activeSubAccountId: 0,
    subAccountIds: [0],
    env: config.perps.driftEnv as "mainnet-beta" | "devnet",
  };

  const client = new DriftClient(driftConfig);
  await client.subscribe();

  cachedDriftClient = client;
  cachedWalletPubkey = pubkeyStr;

  log.info(`DriftClient initialized for ${pubkeyStr}`);
  return client;
}

// ---------------------------------------------------------------------------
// Compute budget
// ---------------------------------------------------------------------------

const PRIORITY_FEE_MICRO_LAMPORTS = 100_000;

// ---------------------------------------------------------------------------
// Public API — buildOpenPositionTx
// ---------------------------------------------------------------------------

export async function buildOpenPositionTx(
  walletPubkey: PublicKey,
  market: string,
  side: "long" | "short",
  leverage: number,
  collateralUsd: number,
  currentPriceUsd: number
): Promise<string> {
  const resolved = resolveMarketName(market);
  const marketInfo = getDriftMarket(resolved);
  if (!marketInfo) throw new Error(`Unknown Drift market: ${market}`);

  const client = await createReadOnlyDriftClient(walletPubkey);

  // --- USDC deposit into Drift margin account ---
  const usdcAmount = new BN(Math.floor(collateralUsd * 10 ** USDC_DECIMALS));
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, walletPubkey);
  const depositIx = await client.getDepositInstruction(
    usdcAmount,
    USDC_SPOT_MARKET_INDEX,
    usdcAta
  );

  // --- Perp order ---
  const sizeUsd = collateralUsd * leverage;
  const baseAssetAmount = new BN(
    Math.floor((sizeUsd / currentPriceUsd) * BASE_PRECISION.toNumber())
  );

  const direction =
    side === "long" ? PositionDirection.LONG : PositionDirection.SHORT;

  const orderParams = getMarketOrderParams({
    marketIndex: marketInfo.marketIndex,
    direction,
    baseAssetAmount,
  });

  const orderIx = await client.getPlacePerpOrderIx(orderParams);

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICRO_LAMPORTS,
    }),
    depositIx,
    orderIx,
  ];

  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: walletPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  log.info(
    `Built Drift open tx: ${resolved} ${side} ${leverage}x collateral=$${collateralUsd.toFixed(2)} size=$${sizeUsd.toFixed(2)} deposit=${usdcAmount.toString()} USDC-raw`
  );

  return serialized;
}

// ---------------------------------------------------------------------------
// Public API — buildClosePositionTx
// ---------------------------------------------------------------------------

export async function buildClosePositionTx(
  walletPubkey: PublicKey,
  market: string,
  side: "long" | "short",
  currentPriceUsd: number
): Promise<string> {
  const resolved = resolveMarketName(market);
  const marketInfo = getDriftMarket(resolved);
  if (!marketInfo) throw new Error(`Unknown Drift market: ${market}`);

  const client = await createReadOnlyDriftClient(walletPubkey);

  // Read the actual on-chain position to get the exact baseAssetAmount.
  // Using an inflated amount causes Drift's margin check to compute a huge
  // margin requirement and reject the order with InsufficientCollateral.
  let baseAssetAmount: BN;
  try {
    const user = client.getUser();
    const perpPosition = user.getPerpPosition(marketInfo.marketIndex);
    if (perpPosition && !perpPosition.baseAssetAmount.isZero()) {
      baseAssetAmount = perpPosition.baseAssetAmount.abs();
      log.info(
        `On-chain position found: ${resolved} baseAssetAmount=${baseAssetAmount.toString()}`
      );
    } else {
      throw new Error("no on-chain position");
    }
  } catch (e) {
    // Fallback: estimate from current price (much better than 1M SOL)
    log.warn(
      `Could not read on-chain position for ${resolved}, estimating from state: ${e instanceof Error ? e.message : String(e)}`
    );
    // Will be overridden by caller-provided fallback if available
    throw new Error(
      `Cannot build close tx: on-chain position not readable for ${resolved}. ` +
      `Ensure DriftClient user subscription is active.`
    );
  }

  // Close = opposite direction + reduceOnly
  const closeDirection =
    side === "long" ? PositionDirection.SHORT : PositionDirection.LONG;

  const orderParams = getMarketOrderParams({
    marketIndex: marketInfo.marketIndex,
    direction: closeDirection,
    baseAssetAmount,
    reduceOnly: true,
  });

  const ix = await client.getPlacePerpOrderIx(orderParams);

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICRO_LAMPORTS,
    }),
    ix,
  ];

  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: walletPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  log.info(
    `Built Drift close tx: ${resolved} ${side} baseAssetAmount=${baseAssetAmount.toString()}`
  );

  return serialized;
}

// ---------------------------------------------------------------------------
// Public API — buildInitializeUserTx
// ---------------------------------------------------------------------------

export async function buildInitializeUserTx(
  walletPubkey: PublicKey
): Promise<string | null> {
  const client = await createReadOnlyDriftClient(walletPubkey);

  // Check if user account already exists
  try {
    const userAccountPublicKey = await client.getUserAccountPublicKey();
    const connection = getConnection();
    const accountInfo = await connection.getAccountInfo(userAccountPublicKey);
    if (accountInfo) {
      log.info("Drift user account already exists, skipping initialization");
      return null;
    }
  } catch {
    // Account doesn't exist, proceed with initialization
  }

  const [initIxs] = await client.getInitializeUserAccountIxs();

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICRO_LAMPORTS,
    }),
    ...initIxs,
  ];

  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: walletPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  log.info("Built Drift initialize user tx");
  return serialized;
}

// ---------------------------------------------------------------------------
// Public API — getUsdcBalanceUsd
// ---------------------------------------------------------------------------

export async function getUsdcBalanceUsd(walletPubkey: PublicKey): Promise<number> {
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, walletPubkey);
  const connection = getConnection();
  try {
    const resp = await connection.getTokenAccountBalance(usdcAta);
    return Number(resp.value.uiAmount ?? 0);
  } catch {
    // ATA doesn't exist or RPC error → 0
    return 0;
  }
}
