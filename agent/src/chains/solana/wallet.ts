import { Connection } from "@solana/web3.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("solana:wallet");

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.solana.rpcUrl, "confirmed");
    log.info(`Connected to ${config.solana.rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
  }
  return connection;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
