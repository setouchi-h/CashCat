import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("solana:wallet");

let connection: Connection | null = null;
let keypair: Keypair | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.solana.rpcUrl, "confirmed");
    log.info(`Connected to ${config.solana.rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
  }
  return connection;
}

export function getKeypair(): Keypair {
  if (!keypair) {
    if (!config.solana.privateKey) {
      throw new Error("SOLANA_PRIVATE_KEY is not set");
    }
    const decoded = Buffer.from(config.solana.privateKey, "base64");
    keypair = Keypair.fromSecretKey(decoded);
    log.info(`Wallet loaded: ${keypair.publicKey.toBase58()}`);
  }
  return keypair;
}

export function getPublicKey(): PublicKey {
  return getKeypair().publicKey;
}

export async function getSolBalance(): Promise<number> {
  const conn = getConnection();
  const balance = await conn.getBalance(getPublicKey());
  return balance / LAMPORTS_PER_SOL;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
