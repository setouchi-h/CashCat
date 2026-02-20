import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import {
  buildAnalysisPrompt,
  type AnalysisResult,
  type TradeDecision,
} from "./prompts.js";
import type { MarketSnapshot } from "../explorer/market.js";
import type { PortfolioBalance } from "../chains/types.js";
import type { TradeRecord } from "../portfolio/tracker.js";

const log = createLogger("brain");

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return client;
}

export async function analyzeMarket(
  snapshot: MarketSnapshot,
  portfolio: PortfolioBalance,
  recentTrades: TradeRecord[]
): Promise<AnalysisResult> {
  const prompt = buildAnalysisPrompt(snapshot, portfolio, recentTrades);

  log.info("Sending market data to Claude for analysis...");

  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";

  log.debug("Claude response", text);

  return parseAnalysisResponse(text);
}

function parseAnalysisResponse(text: string): AnalysisResult {
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    log.warn("Could not parse Claude response as JSON, returning hold");
    return {
      decisions: [
        {
          action: "hold",
          token: "",
          tokenAddress: "",
          amount_pct: 0,
          reasoning: "Failed to parse analysis",
          confidence: 0,
        },
      ],
      marketSummary: "Analysis parsing failed",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]) as AnalysisResult;

    // Validate decisions
    const validDecisions = (parsed.decisions ?? []).filter(
      (d): d is TradeDecision =>
        ["buy", "sell", "hold"].includes(d.action) &&
        typeof d.confidence === "number" &&
        d.confidence >= 0 &&
        d.confidence <= 1 &&
        typeof d.amount_pct === "number" &&
        d.amount_pct >= 0 &&
        d.amount_pct <= 100
    );

    return {
      decisions: validDecisions,
      marketSummary: parsed.marketSummary ?? "",
    };
  } catch (e) {
    log.error("JSON parse error", e);
    return {
      decisions: [
        {
          action: "hold",
          token: "",
          tokenAddress: "",
          amount_pct: 0,
          reasoning: "JSON parse error",
          confidence: 0,
        },
      ],
      marketSummary: "Analysis parsing failed",
    };
  }
}
