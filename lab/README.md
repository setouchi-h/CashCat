# CashCat Lab

Lab is a separate autonomous process that:

1. Collects market prices from Jupiter
2. Builds trading intents and writes them into the runtime queue
3. Reads execution results and updates virtual P&L/positions
4. Emits improvement proposals and reacts to verdicts

## Run

```bash
cp lab/.env.example lab/.env
pnpm --filter lab dev
```

Single cycle mode:

```bash
pnpm --filter lab cycle
```

## Queue Contract

Lab and Agent communicate via files:

- intents: `RUNTIME_INTENT_DIR`
- results: `RUNTIME_RESULT_DIR`
- proposals: `RUNTIME_PROPOSAL_DIR`
- verdicts: `RUNTIME_VERDICT_DIR`

These must match `agent/.env`.

## Auto-run from Agent

Set in `agent/.env`:

```env
RUNTIME_AUTO_RUN_COMMAND=pnpm --filter lab cycle
RUNTIME_AUTO_RUN_CWD=/path/to/CashCat
```

Then start Agent (`pnpm dev`). Agent will trigger one Lab cycle before each execution cycle.
