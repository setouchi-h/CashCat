import { config } from "./config/index.js";
import { createLogger } from "./utils/logger.js";
import { SolanaPlugin } from "./chains/solana/index.js";
import { AgentLoop } from "./agent/loop.js";

const log = createLogger("main");

async function main() {
  log.info("CashCat Trading Agent starting...");
  log.info(`Mode: ${config.paperTrade ? "PAPER TRADE" : "LIVE"}`);
  log.info(`Scan interval: ${config.scanIntervalMinutes} minutes`);

  if (!config.paperTrade) {
    log.warn("LIVE TRADING MODE - Real funds will be used!");
  }

  if (!config.anthropic.apiKey) {
    log.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  // Initialize chain plugins
  const solana = new SolanaPlugin();
  const chains = [solana];

  log.info(`Chains: ${chains.map((c) => c.name).join(", ")}`);

  // Start agent loop
  const agent = new AgentLoop(chains);

  // Graceful shutdown
  process.on("SIGINT", () => {
    log.info("Received SIGINT, shutting down...");
    agent.stop();
  });
  process.on("SIGTERM", () => {
    log.info("Received SIGTERM, shutting down...");
    agent.stop();
  });

  await agent.start();
}

main().catch((e) => {
  log.error("Fatal error", e);
  process.exit(1);
});
