import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import { BorshCoder } from "@coral-xyz/anchor";
import BN from "bn.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("perps");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERPETUALS_PROGRAM_ID = new PublicKey(
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"
);
const JLP_POOL = new PublicKey(
  "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq"
);
const EVENT_AUTHORITY = new PublicKey(
  "37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN"
);

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const ETH_MINT = new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs");
const BTC_MINT = new PublicKey("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Custody addresses per asset
const CUSTODY = {
  SOL: new PublicKey("7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz"),
  ETH: new PublicKey("AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn"),
  BTC: new PublicKey("5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm"),
  USDC: new PublicKey("G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa"),
} as const;

// Underlying mint per market key
const MARKET_MINT: Record<string, PublicKey> = {
  "SOL-PERP": SOL_MINT,
  "ETH-PERP": ETH_MINT,
  "BTC-PERP": BTC_MINT,
};

const MARKET_CUSTODY: Record<string, PublicKey> = {
  "SOL-PERP": CUSTODY.SOL,
  "ETH-PERP": CUSTODY.ETH,
  "BTC-PERP": CUSTODY.BTC,
};

// For longs: collateral custody = market custody (SOL for SOL-PERP)
// For shorts: collateral custody = USDC
function getCollateralCustody(side: "long" | "short", market: string): PublicKey {
  return side === "long" ? MARKET_CUSTODY[market] : CUSTODY.USDC;
}

function getCollateralMint(side: "long" | "short", market: string): PublicKey {
  return side === "long" ? MARKET_MINT[market] : USDC_MINT;
}

// Side enum values
const SIDE_LONG = 1;
const SIDE_SHORT = 2;

// USD amounts use 6 decimals on-chain
const USD_DECIMALS = 6;

// Compute budget
const PRIORITY_FEE_MICRO_LAMPORTS = 100_000;

// ---------------------------------------------------------------------------
// Minimal IDL — only the instructions we need
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PERPETUALS_IDL: any = {
  version: "0.1.0",
  name: "perpetuals",
  instructions: [
    {
      name: "createIncreasePositionMarketRequest",
      discriminator: [183, 198, 97, 169, 35, 1, 225, 57],
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "fundingAccount", isMut: true, isSigner: false },
        { name: "perpetuals", isMut: false, isSigner: false },
        { name: "pool", isMut: false, isSigner: false },
        { name: "position", isMut: true, isSigner: false },
        { name: "positionRequest", isMut: true, isSigner: false },
        { name: "positionRequestAta", isMut: true, isSigner: false },
        { name: "custody", isMut: false, isSigner: false },
        { name: "collateralCustody", isMut: false, isSigner: false },
        { name: "inputMint", isMut: false, isSigner: false },
        { name: "referral", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "associatedTokenProgram", isMut: false, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "eventAuthority", isMut: false, isSigner: false },
        { name: "program", isMut: false, isSigner: false },
      ],
      args: [
        {
          name: "params",
          type: {
            defined: { name: "CreateIncreasePositionMarketRequestParams" },
          },
        },
      ],
    },
    {
      name: "createDecreasePositionMarketRequest",
      discriminator: [147, 238, 76, 91, 48, 86, 167, 253],
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "receivingAccount", isMut: true, isSigner: false },
        { name: "perpetuals", isMut: false, isSigner: false },
        { name: "pool", isMut: false, isSigner: false },
        { name: "position", isMut: false, isSigner: false },
        { name: "positionRequest", isMut: true, isSigner: false },
        { name: "positionRequestAta", isMut: true, isSigner: false },
        { name: "custody", isMut: false, isSigner: false },
        { name: "collateralCustody", isMut: false, isSigner: false },
        { name: "desiredMint", isMut: false, isSigner: false },
        { name: "referral", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "associatedTokenProgram", isMut: false, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "eventAuthority", isMut: false, isSigner: false },
        { name: "program", isMut: false, isSigner: false },
      ],
      args: [
        {
          name: "params",
          type: {
            defined: { name: "CreateDecreasePositionMarketRequestParams" },
          },
        },
      ],
    },
  ],
  accounts: [],
  types: [
    {
      name: "CreateIncreasePositionMarketRequestParams",
      type: {
        kind: "struct",
        fields: [
          { name: "sizeUsdDelta", type: "u64" },
          { name: "collateralTokenDelta", type: "u64" },
          { name: "side", type: { defined: { name: "Side" } } },
          { name: "priceSlippage", type: "u64" },
          { name: "jupiterMinimumOut", type: { option: "u64" } },
          { name: "counter", type: "u64" },
        ],
      },
    },
    {
      name: "CreateDecreasePositionMarketRequestParams",
      type: {
        kind: "struct",
        fields: [
          { name: "collateralUsdDelta", type: "u64" },
          { name: "sizeUsdDelta", type: "u64" },
          { name: "priceSlippage", type: "u64" },
          { name: "jupiterMinimumOut", type: { option: "u64" } },
          { name: "entirePosition", type: { option: "bool" } },
          { name: "counter", type: "u64" },
        ],
      },
    },
    {
      name: "Side",
      type: {
        kind: "enum",
        variants: [
          { name: "None" },
          { name: "Long" },
          { name: "Short" },
        ],
      },
    },
  ],
  errors: [],
  metadata: { address: PERPETUALS_PROGRAM_ID.toBase58() },
};

const coder = new BorshCoder(PERPETUALS_IDL);

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

function findPerpetualsPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("perpetuals")],
    PERPETUALS_PROGRAM_ID
  );
  return pda;
}

function findPositionPda(
  owner: PublicKey,
  custody: PublicKey,
  collateralCustody: PublicKey,
  side: "long" | "short"
): PublicKey {
  const sideByte = side === "long" ? SIDE_LONG : SIDE_SHORT;
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      owner.toBuffer(),
      JLP_POOL.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      Buffer.from([sideByte]),
    ],
    PERPETUALS_PROGRAM_ID
  );
  return pda;
}

function findPositionRequestPda(
  position: PublicKey,
  counter: BN,
  requestChange: "increase" | "decrease"
): PublicKey {
  const changeByte = requestChange === "increase" ? 1 : 2;
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_request"),
      position.toBuffer(),
      counter.toArrayLike(Buffer, "le", 8),
      Buffer.from([changeByte]),
    ],
    PERPETUALS_PROGRAM_ID
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function encodeInstruction(
  name: string,
  data: Record<string, unknown>
): Buffer {
  return coder.instruction.encode(name, data) as unknown as Buffer;
}

function buildIncreasePositionIx(params: {
  owner: PublicKey;
  fundingAccount: PublicKey;
  position: PublicKey;
  positionRequest: PublicKey;
  positionRequestAta: PublicKey;
  custody: PublicKey;
  collateralCustody: PublicKey;
  inputMint: PublicKey;
  sizeUsdDelta: BN;
  collateralTokenDelta: BN;
  side: "long" | "short";
  priceSlippage: BN;
  counter: BN;
}): TransactionInstruction {
  const sideValue = params.side === "long" ? { long: {} } : { short: {} };

  const data = encodeInstruction("createIncreasePositionMarketRequest", {
    params: {
      sizeUsdDelta: params.sizeUsdDelta,
      collateralTokenDelta: params.collateralTokenDelta,
      side: sideValue,
      priceSlippage: params.priceSlippage,
      jupiterMinimumOut: null,
      counter: params.counter,
    },
  });

  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: params.fundingAccount, isSigner: false, isWritable: true },
    { pubkey: findPerpetualsPda(), isSigner: false, isWritable: false },
    { pubkey: JLP_POOL, isSigner: false, isWritable: false },
    { pubkey: params.position, isSigner: false, isWritable: true },
    { pubkey: params.positionRequest, isSigner: false, isWritable: true },
    { pubkey: params.positionRequestAta, isSigner: false, isWritable: true },
    { pubkey: params.custody, isSigner: false, isWritable: false },
    { pubkey: params.collateralCustody, isSigner: false, isWritable: false },
    { pubkey: params.inputMint, isSigner: false, isWritable: false },
    { pubkey: PERPETUALS_PROGRAM_ID, isSigner: false, isWritable: false }, // referral = program (null)
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PERPETUALS_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PERPETUALS_PROGRAM_ID,
    keys,
    data,
  });
}

function buildDecreasePositionIx(params: {
  owner: PublicKey;
  receivingAccount: PublicKey;
  position: PublicKey;
  positionRequest: PublicKey;
  positionRequestAta: PublicKey;
  custody: PublicKey;
  collateralCustody: PublicKey;
  desiredMint: PublicKey;
  priceSlippage: BN;
  entirePosition: boolean;
  counter: BN;
}): TransactionInstruction {
  const data = encodeInstruction("createDecreasePositionMarketRequest", {
    params: {
      collateralUsdDelta: new BN(0),
      sizeUsdDelta: new BN(0),
      priceSlippage: params.priceSlippage,
      jupiterMinimumOut: null,
      entirePosition: params.entirePosition,
      counter: params.counter,
    },
  });

  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: params.receivingAccount, isSigner: false, isWritable: true },
    { pubkey: findPerpetualsPda(), isSigner: false, isWritable: false },
    { pubkey: JLP_POOL, isSigner: false, isWritable: false },
    { pubkey: params.position, isSigner: false, isWritable: false },
    { pubkey: params.positionRequest, isSigner: false, isWritable: true },
    { pubkey: params.positionRequestAta, isSigner: false, isWritable: true },
    { pubkey: params.custody, isSigner: false, isWritable: false },
    { pubkey: params.collateralCustody, isSigner: false, isWritable: false },
    { pubkey: params.desiredMint, isSigner: false, isWritable: false },
    { pubkey: PERPETUALS_PROGRAM_ID, isSigner: false, isWritable: false }, // referral = program (null)
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PERPETUALS_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PERPETUALS_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getRpcUrl(): string {
  return (
    process.env.SOLANA_RPC_URL ??
    "https://api.mainnet-beta.solana.com"
  );
}

function getConnection(): Connection {
  return new Connection(getRpcUrl(), "confirmed");
}

export async function buildOpenPositionTx(
  walletPubkey: PublicKey,
  market: string,
  side: "long" | "short",
  leverage: number,
  collateralAmount: number,
  currentPriceUsd: number
): Promise<string> {
  const custody = MARKET_CUSTODY[market];
  const collateralCustody = getCollateralCustody(side, market);
  const inputMint = getCollateralMint(side, market);

  if (!custody) throw new Error(`Unknown market: ${market}`);

  const position = findPositionPda(walletPubkey, custody, collateralCustody, side);
  const counter = new BN(Math.floor(Math.random() * 1_000_000_000));
  const positionRequest = findPositionRequestPda(position, counter, "increase");
  const positionRequestAta = getAssociatedTokenAddressSync(
    inputMint,
    positionRequest,
    true // allowOwnerOffCurve — PDA owner
  );

  const sizeUsd = collateralAmount * leverage;
  const sizeUsdDelta = new BN(Math.floor(sizeUsd * 10 ** USD_DECIMALS));

  // collateralTokenDelta: native amount of collateral token
  // For SOL longs: collateral in lamports
  // For shorts: collateral in USDC (6 decimals)
  let collateralTokenDelta: BN;
  if (inputMint.equals(SOL_MINT)) {
    // Convert USD to SOL lamports
    const solAmount = collateralAmount / currentPriceUsd;
    collateralTokenDelta = new BN(Math.floor(solAmount * 1_000_000_000));
  } else if (inputMint.equals(USDC_MINT)) {
    collateralTokenDelta = new BN(Math.floor(collateralAmount * 10 ** 6));
  } else {
    throw new Error(`Unsupported collateral mint: ${inputMint.toBase58()}`);
  }

  // Price slippage: max acceptable entry price (with 10% buffer)
  const slippageMultiplier = side === "long" ? 1.10 : 0.90;
  const priceSlippage = new BN(
    Math.floor(currentPriceUsd * slippageMultiplier * 10 ** USD_DECIMALS)
  );

  const instructions: TransactionInstruction[] = [];

  // Compute budget
  instructions.push(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICRO_LAMPORTS,
    })
  );

  // wSOL wrap if needed
  const isNativeSol = inputMint.equals(NATIVE_MINT);
  const fundingAccount = getAssociatedTokenAddressSync(inputMint, walletPubkey);

  if (isNativeSol) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        walletPubkey,
        fundingAccount,
        walletPubkey,
        NATIVE_MINT
      )
    );
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: walletPubkey,
        toPubkey: fundingAccount,
        lamports: BigInt(collateralTokenDelta.toString()),
      })
    );
    instructions.push(createSyncNativeInstruction(fundingAccount));
  }

  // Main instruction
  instructions.push(
    buildIncreasePositionIx({
      owner: walletPubkey,
      fundingAccount,
      position,
      positionRequest,
      positionRequestAta,
      custody,
      collateralCustody,
      inputMint,
      sizeUsdDelta,
      collateralTokenDelta,
      side,
      priceSlippage,
      counter,
    })
  );

  // Close wSOL ATA after (return rent)
  if (isNativeSol) {
    instructions.push(
      createCloseAccountInstruction(fundingAccount, walletPubkey, walletPubkey)
    );
  }

  const conn = getConnection();
  const { blockhash } = await conn.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: walletPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  log.info(
    `Built open position tx: ${market} ${side} ${leverage}x collateral=$${collateralAmount} size=$${sizeUsd}`
  );

  return serialized;
}

export async function buildClosePositionTx(
  walletPubkey: PublicKey,
  market: string,
  side: "long" | "short",
  currentPriceUsd: number
): Promise<string> {
  const custody = MARKET_CUSTODY[market];
  const collateralCustody = getCollateralCustody(side, market);
  const desiredMint = getCollateralMint(side, market);

  if (!custody) throw new Error(`Unknown market: ${market}`);

  const position = findPositionPda(walletPubkey, custody, collateralCustody, side);
  const counter = new BN(Math.floor(Math.random() * 1_000_000_000));
  const positionRequest = findPositionRequestPda(position, counter, "decrease");
  const positionRequestAta = getAssociatedTokenAddressSync(
    desiredMint,
    positionRequest,
    true
  );

  // Price slippage for close: inverse of open
  const slippageMultiplier = side === "long" ? 0.90 : 1.10;
  const priceSlippage = new BN(
    Math.floor(currentPriceUsd * slippageMultiplier * 10 ** USD_DECIMALS)
  );

  const receivingAccount = getAssociatedTokenAddressSync(desiredMint, walletPubkey);

  const instructions: TransactionInstruction[] = [];

  instructions.push(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICRO_LAMPORTS,
    })
  );

  // Ensure receiving ATA exists
  if (desiredMint.equals(NATIVE_MINT)) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        walletPubkey,
        receivingAccount,
        walletPubkey,
        NATIVE_MINT
      )
    );
  }

  instructions.push(
    buildDecreasePositionIx({
      owner: walletPubkey,
      receivingAccount,
      position,
      positionRequest,
      positionRequestAta,
      custody,
      collateralCustody,
      desiredMint,
      priceSlippage,
      entirePosition: true,
      counter,
    })
  );

  const conn = getConnection();
  const { blockhash } = await conn.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: walletPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  log.info(`Built close position tx: ${market} ${side} entirePosition=true`);

  return serialized;
}
