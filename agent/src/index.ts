import { createLogger } from "./logger.js";
import { runLoop } from "./loop.js";

const log = createLogger("main");

// Drift SDK and @solana/web3.js fire background fetches (WebSocket
// subscriptions, BulkAccountLoader polls) that can throw outside any
// promise chain when the RPC is temporarily unreachable. Without these
// handlers the process crashes on transient network blips.
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception (non-fatal): ${err.message}`);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error(`Unhandled rejection (non-fatal): ${msg}`);
});

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

runLoop(controller.signal).catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
