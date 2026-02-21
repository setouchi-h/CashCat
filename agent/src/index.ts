import { config } from "./config/index.js";
import { createLogger } from "./utils/logger.js";
import { SolanaPlugin } from "./chains/solana/index.js";
import { AgentLoop } from "./agent/loop.js";

const log = createLogger("main");

async function main() {
  log.info("CashCat Trading Agent starting...");
  log.info(`Mode: ${config.paperTrade ? "PAPER TRADE" : "LIVE"}`);
  log.info("Execution mode: external intents");
  log.info(
    `Execution backend: ${
      config.runtime.walletMcp.enabled
        ? `wallet-mcp (${config.runtime.walletMcp.command})`
        : "direct chain plugin"
    }`
  );
  log.info(
    `Agentic planner: ${
      config.runtime.agentic.enabled
        ? `ON mode=${config.runtime.agentic.plannerMode} (${config.runtime.agentic.tokenUniverse
            .map((token) => token.symbol)
            .join(", ")})`
        : "OFF"
    }`
  );
  log.info(`Scan interval: ${config.scanIntervalSeconds} seconds`);
  log.info(
    `Runtime queue: intents=${config.runtime.intentDir}, results=${config.runtime.resultDir}, proposals=${config.runtime.proposalDir}, verdicts=${config.runtime.verdictDir}`
  );
  log.info(
    `Runtime guard: killSwitch=${config.runtime.killSwitch ? "ON" : "OFF"}, maxAmount=${config.runtime.maxAmountLamports}, maxSlippage=${config.runtime.maxSlippageBps}bps`
  );
  log.info(
    `Gate: minPnlDelta=${config.runtime.gate.minPnlDeltaPct}%, minSharpeDelta=${config.runtime.gate.minSharpeDelta}, maxDrawdownDelta=${config.runtime.gate.maxDrawdownDeltaPct}%, minTestPassRate=${config.runtime.gate.minTestPassRate}`
  );

  if (!config.paperTrade) {
    log.warn("LIVE TRADING MODE - Real funds will be used!");
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
