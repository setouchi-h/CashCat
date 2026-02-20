import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import { getAccessToken } from "../auth/oauth.js";
import {
  buildAnalysisPrompt,
  type AnalysisResult,
  type TradeDecision,
} from "./prompts.js";
import type { MarketSnapshot } from "../explorer/market.js";
import type { PortfolioBalance } from "../chains/types.js";
import type { TradeRecord } from "../portfolio/tracker.js";

const log = createLogger("brain");

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

async function callChatGPTOAuth(prompt: string): Promise<string> {
  const accessToken = await getAccessToken();
  const { model, reasoningEffort } = config.openai;

  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  };

  // Add reasoning_effort for thinking-capable models (gpt-5.2, gpt-5.2-pro)
  if (reasoningEffort !== "none") {
    body.reasoning_effort = reasoningEffort;
  }

  log.info(`ChatGPT: model=${model}, reasoning_effort=${reasoningEffort}`);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `ChatGPT API error: ${res.status} ${await res.text()}`
    );
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };

  return data.choices[0]?.message?.content ?? "";
}

async function callAnthropic(prompt: string): Promise<string> {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return message.content[0].type === "text" ? message.content[0].text : "";
}

export async function analyzeMarket(
  snapshot: MarketSnapshot,
  portfolio: PortfolioBalance,
  recentTrades: TradeRecord[]
): Promise<AnalysisResult> {
  const prompt = buildAnalysisPrompt(snapshot, portfolio, recentTrades);
  const provider = config.llmProvider;

  log.info(`Sending market data to ${provider} for analysis...`);

  let text: string;

  if (provider === "chatgpt-oauth") {
    text = await callChatGPTOAuth(prompt);
  } else {
    text = await callAnthropic(prompt);
  }

  log.debug("LLM response", text);

  return parseAnalysisResponse(text);
}

function parseAnalysisResponse(text: string): AnalysisResult {
  const jsonMatch =
    text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    log.warn("Could not parse LLM response as JSON, returning hold");
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
