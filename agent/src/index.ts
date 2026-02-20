import { config } from "./config/index.js";
import { createLogger } from "./utils/logger.js";
import { SolanaPlugin } from "./chains/solana/index.js";
import { AgentLoop } from "./agent/loop.js";
import { getAccessToken } from "./auth/oauth.js";

const log = createLogger("main");

async function main() {
  log.info("CashCat Trading Agent starting...");
  log.info(`Mode: ${config.paperTrade ? "PAPER TRADE" : "LIVE"}`);
  log.info(`LLM: ${config.llmProvider}`);
  log.info(`Scan interval: ${config.scanIntervalMinutes} minutes`);

  if (!config.paperTrade) {
    log.warn("LIVE TRADING MODE - Real funds will be used!");
  }

  // Validate LLM credentials
  if (config.llmProvider === "chatgpt-oauth") {
    log.info("Using ChatGPT via OAuth. Checking authentication...");
    await getAccessToken(); // triggers login if needed
    log.info("ChatGPT OAuth authenticated.");
  } else if (config.llmProvider === "anthropic") {
    if (!config.anthropic.apiKey) {
      log.error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
      process.exit(1);
    }
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
