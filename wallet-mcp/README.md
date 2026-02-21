# Wallet MCP

`wallet-mcp` is a standalone MCP server for wallet and swap execution.

- AI process generates intents.
- `wallet-mcp` enforces policy guardrails.
- Signing and transaction submission stay inside this process.
- Every action is appended to a JSONL ledger.

## Tools

- `wallet_get_balance`
- `wallet_get_quote`
- `wallet_execute_swap`
- `wallet_get_tx`
- `wallet_get_policy`

## Run

```bash
cp wallet-mcp/.env.example wallet-mcp/.env
pnpm --filter wallet-mcp dev
```

## Environment

- Minimal:
  - `PAPER_TRADE` (`true` by default)
  - `SOLANA_PRIVATE_KEY` (required only for live execution)
- Optional:
  - `HELIUS_API_KEY`
  - `JUPITER_API_KEY`
- Advanced overrides (optional, defaults are in code):
  - `JUPITER_API_BASE_URL`
  - `WALLET_MCP_KILL_SWITCH`
  - `WALLET_MCP_MAX_AMOUNT_LAMPORTS`
  - `WALLET_MCP_MAX_SLIPPAGE_BPS`
  - `WALLET_MCP_ALLOWED_INPUT_MINTS`
  - `WALLET_MCP_ALLOWED_OUTPUT_MINTS`
  - `WALLET_MCP_LEDGER_PATH`
  - `WALLET_MCP_QUOTE_TTL_SECONDS`
