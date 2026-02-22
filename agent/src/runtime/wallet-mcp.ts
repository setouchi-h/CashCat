import { spawn } from "node:child_process";
import type { TradeOrder, TradeResult } from "../chains/types.js";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("runtime:wallet-mcp");

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface WalletExecuteResult {
  intentId?: string;
  status?: "filled" | "failed" | "rejected";
  txHash?: string;
  inputAmount?: string;
  outputAmount?: string;
  error?: string;
  reason?: string;
}

function writeFrame(
  writer: NodeJS.WritableStream,
  payload: JsonRpcRequest
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  writer.write(header);
  writer.write(body);
}

function extractResultPayload(value: unknown): WalletExecuteResult {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid tools/call response");
  }

  const obj = value as {
    isError?: unknown;
    content?: unknown;
  };

  const content = Array.isArray(obj.content) ? obj.content : [];
  const first = content[0] as { text?: unknown } | undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  if (!text) {
    throw new Error("wallet_execute_swap returned empty content");
  }

  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text when tool returned plain text
  }

  if (typeof parsed === "string") {
    return { status: obj.isError ? "failed" : "filled", error: parsed };
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("wallet_execute_swap returned invalid payload");
  }

  return parsed as WalletExecuteResult;
}

function parseFrames(
  buffer: Buffer<ArrayBufferLike>
): { rest: Buffer<ArrayBufferLike>; messages: JsonRpcResponse[] } {
  let cursor = buffer;
  const messages: JsonRpcResponse[] = [];

  while (true) {
    const headerEnd = cursor.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = cursor.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      cursor = cursor.subarray(headerEnd + 4);
      continue;
    }

    const bodyLength = Number(match[1]);
    if (!Number.isInteger(bodyLength) || bodyLength < 0) {
      cursor = cursor.subarray(headerEnd + 4);
      continue;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + bodyLength;
    if (cursor.length < bodyEnd) break;

    const body = cursor.subarray(bodyStart, bodyEnd).toString("utf8");
    cursor = cursor.subarray(bodyEnd);

    try {
      messages.push(JSON.parse(body) as JsonRpcResponse);
    } catch {
      // ignore malformed frame
    }
  }

  return { rest: cursor, messages };
}

export interface WalletBalance {
  lamports: string;
  sol: string;
}

export async function getBalanceViaWalletMcp(): Promise<WalletBalance> {
  if (!config.runtime.walletMcp.enabled) {
    throw new Error("wallet-mcp is disabled");
  }

  const command = config.runtime.walletMcp.command.trim();
  if (!command) {
    throw new Error("RUNTIME_WALLET_MCP_COMMAND is empty");
  }

  const cwd = config.runtime.walletMcp.cwd.trim() || process.cwd();
  const timeoutMs = Math.max(5, config.runtime.walletMcp.timeoutSeconds) * 1000;

  return await new Promise<WalletBalance>((resolve, reject) => {
    const child = spawn("zsh", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: "pipe",
    });

    const initRequestId = 1;
    const toolCallRequestId = 2;
    let done = false;
    let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr = "";

    const finish = (result: WalletBalance | Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`wallet-mcp balance call timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      const parsed = parseFrames(stdoutBuffer);
      stdoutBuffer = parsed.rest;

      for (const message of parsed.messages) {
        if (done) return;
        if (typeof message.id !== "number") continue;

        if (message.id === initRequestId) {
          if (message.error) {
            finish(new Error(`wallet-mcp initialize failed: ${message.error.message}`));
            return;
          }

          writeFrame(child.stdin, {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          });

          writeFrame(child.stdin, {
            jsonrpc: "2.0",
            id: toolCallRequestId,
            method: "tools/call",
            params: {
              name: "wallet_get_balance",
              arguments: { chain: "solana" },
            },
          });
          continue;
        }

        if (message.id === toolCallRequestId) {
          if (message.error) {
            finish(new Error(`wallet_get_balance RPC error: ${message.error.message}`));
            return;
          }

          try {
            const value = message.result as {
              content?: Array<{ text?: string }>;
            };
            const text = value?.content?.[0]?.text ?? "";
            if (!text) {
              finish(new Error("wallet_get_balance returned empty content"));
              return;
            }
            const payload = JSON.parse(text) as Record<string, unknown>;
            const lamports = String(payload.lamports ?? "0");
            const sol = String(payload.sol ?? String(Number(lamports) / 1_000_000_000));
            finish({ lamports, sol });
          } catch (e) {
            finish(new Error(`wallet_get_balance parse error: ${e instanceof Error ? e.message : String(e)}`));
          }
          return;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    child.on("error", (e) => {
      finish(new Error(`wallet-mcp spawn failed: ${e instanceof Error ? e.message : String(e)}`));
    });

    child.on("close", (code) => {
      if (done) return;
      const stderrTail = stderr.trim() ? ` | stderr=${stderr.trim()}` : "";
      finish(new Error(`wallet-mcp exited before response (code=${code})${stderrTail}`));
    });

    writeFrame(child.stdin, {
      jsonrpc: "2.0",
      id: initRequestId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "cashcat-agent",
          version: "0.1.0",
        },
      },
    });
  });
}

export async function executeTradeViaWalletMcp(
  intentId: string,
  order: TradeOrder
): Promise<TradeResult> {
  if (!config.runtime.walletMcp.enabled) {
    return {
      success: false,
      inputAmount: String(order.amountLamports),
      outputAmount: "0",
      error: "wallet-mcp execution is disabled",
    };
  }

  const command = config.runtime.walletMcp.command.trim();
  if (!command) {
    return {
      success: false,
      inputAmount: String(order.amountLamports),
      outputAmount: "0",
      error: "RUNTIME_WALLET_MCP_COMMAND is empty",
    };
  }

  const cwd = config.runtime.walletMcp.cwd.trim() || process.cwd();
  const timeoutMs = Math.max(5, config.runtime.walletMcp.timeoutSeconds) * 1000;

  return await new Promise<TradeResult>((resolve) => {
    const child = spawn("zsh", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: "pipe",
    });

    const initRequestId = 1;
    const toolCallRequestId = 2;
    let done = false;
    let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr = "";

    const finish = (result: TradeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };

    const timer = setTimeout(() => {
      const error = `wallet-mcp call timed out after ${timeoutMs}ms`;
      log.warn(error);
      finish({
        success: false,
        inputAmount: String(order.amountLamports),
        outputAmount: "0",
        error,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      const parsed = parseFrames(stdoutBuffer);
      stdoutBuffer = parsed.rest;

      for (const message of parsed.messages) {
        if (done) return;
        if (typeof message.id !== "number") continue;

        if (message.id === initRequestId) {
          if (message.error) {
            finish({
              success: false,
              inputAmount: String(order.amountLamports),
              outputAmount: "0",
              error: `wallet-mcp initialize failed: ${message.error.message}`,
            });
            return;
          }

          writeFrame(child.stdin, {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          });

          writeFrame(child.stdin, {
            jsonrpc: "2.0",
            id: toolCallRequestId,
            method: "tools/call",
            params: {
              name: "wallet_execute_swap",
              arguments: {
                chain: "solana",
                intentId,
                inputMint: order.inputMint,
                outputMint: order.outputMint,
                amountLamports: order.amountLamports,
                slippageBps: order.slippageBps,
              },
            },
          });
          continue;
        }

        if (message.id === toolCallRequestId) {
          if (message.error) {
            finish({
              success: false,
              inputAmount: String(order.amountLamports),
              outputAmount: "0",
              error: `wallet_execute_swap RPC error: ${message.error.message}`,
            });
            return;
          }

          try {
            const payload = extractResultPayload(message.result);
            const success = payload.status === "filled";
            finish({
              success,
              txHash: payload.txHash,
              inputAmount: payload.inputAmount ?? String(order.amountLamports),
              outputAmount: payload.outputAmount ?? "0",
              error:
                payload.error ??
                payload.reason ??
                (success ? undefined : "wallet_execute_swap failed"),
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            finish({
              success: false,
              inputAmount: String(order.amountLamports),
              outputAmount: "0",
              error: msg,
            });
          }
          return;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    child.on("error", (e) => {
      finish({
        success: false,
        inputAmount: String(order.amountLamports),
        outputAmount: "0",
        error: `wallet-mcp spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    });

    child.on("close", (code) => {
      if (done) return;

      const stderrTail = stderr.trim() ? ` | stderr=${stderr.trim()}` : "";
      finish({
        success: false,
        inputAmount: String(order.amountLamports),
        outputAmount: "0",
        error: `wallet-mcp exited before response (code=${code})${stderrTail}`,
      });
    });

    writeFrame(child.stdin, {
      jsonrpc: "2.0",
      id: initRequestId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "cashcat-agent",
          version: "0.1.0",
        },
      },
    });
  });
}
