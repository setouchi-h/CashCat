# Strategy Log

## Lessons

- Jupiter error 0x1788 = InsufficientFunds (on-chain balance < requested swap amount), NOT a slippage or "guardrail" error. Do not retry — the state will reconcile with on-chain balances next cycle.
- Jupiter error 0x1771 = SlippageToleranceExceeded. Retry with smaller amount may help.
- USDC is used as both a spot position and Drift perp collateral. Opening perps drains USDC from the wallet without updating the spot position ledger. The engine now reconciles spot positions with on-chain balances every cycle, so this desync self-corrects.
- Repeated failures on the same trade across cycles means the underlying condition (insufficient balance, broken route, etc.) hasn't changed. Do not keep retrying the same failing trade — investigate or skip.

## Current Plan

(Codex: write your current trading plan here each cycle)
