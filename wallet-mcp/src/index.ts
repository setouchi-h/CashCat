import { config } from "./config.js";
import { appendLedgerEvent } from "./ledger.js";
import { createLogger } from "./logger.js";
import { isValidMint, validateSwapPolicy } from "./policy.js";
import {
  executeSwap,
  getBalance,
  getQuote,
  getStoredQuote,
  getTransactionStatus,
  getWalletAddress,
  signAndSendTransaction,
} from "./solana.js";

const log = createLogger("server");

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolCallRequest {
  name: string;
  arguments?: unknown;
}

const tools = [
  {
    name: "wallet_get_balance",
    description: "Get SOL balance for account (or server wallet when omitted).",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana"] },
        account: { type: "string" },
      },
      required: ["chain"],
      additionalProperties: false,
    },
  },
  {
    name: "wallet_get_quote",
    description: "Get a Jupiter swap quote and return quoteId.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana"] },
        inputMint: { type: "string" },
        outputMint: { type: "string" },
        amountLamports: { type: "integer", minimum: 1 },
        slippageBps: { type: "integer", minimum: 1 },
      },
      required: ["chain", "inputMint", "outputMint", "amountLamports", "slippageBps"],
      additionalProperties: false,
    },
  },
  {
    name: "wallet_execute_swap",
    description:
      "Execute a swap by quoteId, or with full params when quoteId is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana"] },
        intentId: { type: "string" },
        quoteId: { type: "string" },
        inputMint: { type: "string" },
        outputMint: { type: "string" },
        amountLamports: { type: "integer", minimum: 1 },
        slippageBps: { type: "integer", minimum: 1 },
      },
      required: ["chain"],
      additionalProperties: false,
    },
  },
  {
    name: "wallet_get_tx",
    description: "Get transaction confirmation status by tx hash.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana"] },
        txHash: { type: "string" },
      },
      required: ["chain", "txHash"],
      additionalProperties: false,
    },
  },
  {
    name: "wallet_sign_and_send",
    description:
      "Sign and send a pre-built transaction (base64-encoded VersionedTransaction).",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana"] },
        intentId: { type: "string" },
        transaction: { type: "string" },
        description: { type: "string" },
      },
      required: ["chain", "intentId", "transaction", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "wallet_get_policy",
    description: "Return current runtime policy and mode.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana"] },
      },
      required: ["chain"],
      additionalProperties: false,
    },
  },
] as const;

function writeMessage(payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  process.stdout.write(header);
  process.stdout.write(body);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  const response: JsonRpcSuccessResponse = { jsonrpc: "2.0", id, result };
  writeMessage(response);
}

function sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  const response: JsonRpcErrorResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
  writeMessage(response);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function readRequiredString(
  args: Record<string, unknown>,
  key: string
): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const value = args[key];
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string when provided`);
  }
  return value.trim();
}

function readRequiredInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return Number(value);
}

function ensureSolanaChain(args: Record<string, unknown>): void {
  const chain = readRequiredString(args, "chain");
  if (chain !== "solana") {
    throw new Error(`Unsupported chain: ${chain}`);
  }
}

async function callTool(request: ToolCallRequest): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const name = request.name;
  const args = asObject(request.arguments ?? {});

  switch (name) {
    case "wallet_get_balance": {
      ensureSolanaChain(args);
      const account = readOptionalString(args, "account");
      const result = await getBalance(account);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    case "wallet_get_quote": {
      ensureSolanaChain(args);
      const inputMint = readRequiredString(args, "inputMint");
      const outputMint = readRequiredString(args, "outputMint");
      const amountLamports = readRequiredInteger(args, "amountLamports");
      const slippageBps = readRequiredInteger(args, "slippageBps");

      if (!isValidMint(inputMint)) throw new Error("inputMint is invalid");
      if (!isValidMint(outputMint)) throw new Error("outputMint is invalid");

      const policyRejection = validateSwapPolicy({
        inputMint,
        outputMint,
        amountLamports,
        slippageBps,
      });
      if (policyRejection) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "rejected", reason: policyRejection }),
            },
          ],
        };
      }

      const result = await getQuote({
        inputMint,
        outputMint,
        amountLamports,
        slippageBps,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    case "wallet_execute_swap": {
      ensureSolanaChain(args);
      const intentId = readOptionalString(args, "intentId");
      const quoteId = readOptionalString(args, "quoteId");

      if (quoteId) {
        const quote = getStoredQuote(quoteId);
        if (!quote) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected",
                  reason: "quoteId not found or expired",
                }),
              },
            ],
          };
        }

        const policyRejection = validateSwapPolicy({
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amountLamports: Number(quote.inAmount),
          slippageBps: quote.slippageBps,
        });
        if (policyRejection) {
          await appendLedgerEvent("swap_rejected", {
            intentId: intentId ?? "n/a",
            quoteId,
            reason: policyRejection,
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "rejected", reason: policyRejection }),
              },
            ],
          };
        }

        const result = await executeSwap({ intentId, quoteId });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      const inputMint = readRequiredString(args, "inputMint");
      const outputMint = readRequiredString(args, "outputMint");
      const amountLamports = readRequiredInteger(args, "amountLamports");
      const slippageBps = readRequiredInteger(args, "slippageBps");

      const policyRejection = validateSwapPolicy({
        inputMint,
        outputMint,
        amountLamports,
        slippageBps,
      });
      if (policyRejection) {
        await appendLedgerEvent("swap_rejected", {
          intentId: intentId ?? "n/a",
          reason: policyRejection,
          inputMint,
          outputMint,
          amountLamports,
          slippageBps,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "rejected", reason: policyRejection }),
            },
          ],
        };
      }

      const result = await executeSwap({
        intentId,
        quoteRequest: {
          inputMint,
          outputMint,
          amountLamports,
          slippageBps,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    case "wallet_sign_and_send": {
      ensureSolanaChain(args);
      const intentId = readRequiredString(args, "intentId");
      const transaction = readRequiredString(args, "transaction");
      const description = readRequiredString(args, "description");
      const result = await signAndSendTransaction({
        intentId,
        transaction,
        description,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    case "wallet_get_tx": {
      ensureSolanaChain(args);
      const txHash = readRequiredString(args, "txHash");
      const result = await getTransactionStatus(txHash);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    case "wallet_get_policy": {
      ensureSolanaChain(args);
      const wallet = config.solana.privateKey ? getWalletAddress() : null;
      const result = {
        chain: "solana",
        mode: config.paperTrade ? "paper" : "live",
        wallet,
        policy: config.policy,
        quoteTtlSeconds: config.quotes.ttlSeconds,
        ledgerPath: config.ledger.path,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const id = typeof request.id === "undefined" ? null : request.id;
  const method = request.method;

  if (method === "notifications/initialized") return;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: config.server.protocolVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: config.server.name,
        version: config.server.version,
      },
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }

  if (method === "tools/call") {
    try {
      const params = asObject(request.params);
      const toolRequest: ToolCallRequest = {
        name: readRequiredString(params, "name"),
        arguments: params.arguments,
      };
      const result = await callTool(toolRequest);
      sendResult(id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendResult(id, {
        isError: true,
        content: [{ type: "text", text: message }],
      });
    }
    return;
  }

  if (id !== null) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

let readBuffer = Buffer.alloc(0);

function consumeFrames(): void {
  while (true) {
    const headerEnd = readBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = readBuffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      readBuffer = readBuffer.subarray(headerEnd + 4);
      continue;
    }

    const contentLength = Number(match[1]);
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      readBuffer = readBuffer.subarray(headerEnd + 4);
      continue;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (readBuffer.length < bodyEnd) return;

    const body = readBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    readBuffer = readBuffer.subarray(bodyEnd);

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body) as JsonRpcRequest;
    } catch {
      sendError(null, -32700, "Parse error");
      continue;
    }

    if (
      !request ||
      typeof request !== "object" ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string"
    ) {
      sendError(null, -32600, "Invalid request");
      continue;
    }

    void handleRequest(request).catch((error) => {
      log.error("Unhandled request failure", error);
      if (typeof request.id !== "undefined") {
        sendError(request.id, -32000, "Internal error");
      }
    });
  }
}

async function main(): Promise<void> {
  log.info(
    `Starting ${config.server.name} v${config.server.version} (mode=${config.paperTrade ? "paper" : "live"
    })`
  );
  log.info(
    `Policy killSwitch=${config.policy.killSwitch} maxSlippage=${config.policy.maxSlippageBps}`
  );

  process.stdin.on("data", (chunk: Buffer) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    consumeFrames();
  });
  process.stdin.on("error", (error) => {
    log.error("stdin error", error);
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
