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
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid OAuth token format");
  }

  const payload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");

  const decoded = Buffer.from(payload, "base64").toString("utf8");
  return JSON.parse(decoded) as Record<string, unknown>;
}

function extractChatGptAccountId(token: string): string {
  const payload = decodeJwtPayload(token);
  const auth = payload[JWT_CLAIM_PATH];
  if (!auth || typeof auth !== "object") {
    throw new Error("OAuth token is missing OpenAI auth claims");
  }

  const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("OAuth token is missing chatgpt_account_id");
  }
  return accountId;
}

function extractTextFromResponseItem(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const typed = item as { type?: unknown; content?: unknown };
  if (typed.type !== "message" || !Array.isArray(typed.content)) return "";

  return typed.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (p.type === "output_text" && typeof p.text === "string") return p.text;
      if (p.type === "refusal" && typeof p.refusal === "string") return p.refusal;
      return "";
    })
    .join("");
}

function extractTextFromCompletedResponse(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  return output.map(extractTextFromResponseItem).filter(Boolean).join("\n");
}

async function parseCodexSseText(res: Response): Promise<string> {
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const rawEvent = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");

      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();

      if (!data) continue;
      if (data === "[DONE]") return text.trim();

      let event: {
        type?: string;
        delta?: string;
        item?: unknown;
        response?: unknown;
      };

      try {
        event = JSON.parse(data) as {
          type?: string;
          delta?: string;
          item?: unknown;
          response?: unknown;
        };
      } catch {
        continue;
      }

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
        continue;
      }

      if (event.type === "response.output_item.done" && !text) {
        const fromItem = extractTextFromResponseItem(event.item);
        if (fromItem) text += fromItem;
        continue;
      }

      if (event.type === "response.completed" && !text) {
        const fromCompleted = extractTextFromCompletedResponse(event.response);
        if (fromCompleted) text += fromCompleted;
      }
    }
  }

  return text.trim();
}

async function callOpenAIApiKey(prompt: string, apiKey: string): Promise<string> {
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

  log.info(`ChatGPT: model=${model}, reasoning_effort=${reasoningEffort}, auth=api-key`);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`ChatGPT API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };

  return data.choices[0]?.message?.content ?? "";
}

async function callChatGPTOAuth(prompt: string): Promise<string> {
  const usingApiKey = Boolean(config.openai.apiKey);
  if (usingApiKey) {
    return callOpenAIApiKey(prompt, config.openai.apiKey);
  }

  const accessToken = await getAccessToken();
  const accountId = extractChatGptAccountId(accessToken);
  const { model, reasoningEffort } = config.openai;

  const body: Record<string, unknown> = {
    model,
    store: false,
    stream: true,
    instructions: prompt,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Analyze the provided instructions and return JSON only." }],
      },
    ],
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
  };

  if (reasoningEffort !== "none") {
    body.reasoning = {
      effort: reasoningEffort,
      summary: "auto",
    };
  }

  log.info(`ChatGPT: model=${model}, reasoning_effort=${reasoningEffort}, auth=oauth-codex`);

  const res = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "cashcat",
      "User-Agent": "cashcat-agent",
      accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`ChatGPT Codex API error: ${res.status} ${await res.text()}`);
  }

  return parseCodexSseText(res);
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
