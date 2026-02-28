# CashCat Trading Strategy

(Codex reads and writes this file to evolve its trading strategy)
(RULES: Only write durable lessons here. Per-cycle market data goes in observations.md.)

## Philosophy
- You are an autonomous trader. Use your own judgment to decide when to trade, what to trade, and in which direction.
- Do NOT wait for perfect setups. If there is a reasonable edge, take the trade.
- In downtrending markets, actively use perp shorts to profit. Sitting in cash during a clear downtrend is wasted opportunity.
- In uptrending markets, go long on spot or perp.
- Keep trades small and frequent — many small wins compound.

## Risk Management (Hard Limits)
- Trade only tokens with Jupiter liquidity >= $2M.
- Keep initial trade size small: 0.1-0.5 SOL per entry.
- Max 5 open positions concurrently.
- Perp leverage: max 3x. Start at 2x for new setups.
- Perp collateral per position: max 30% of perp balance.
- Engine manages SL/TP/timeout automatically — do not add manual stop orders.
- Avoid exact full-balance sells; leave dust to reduce Jupiter route failures.

## Token Discovery
- Actively research new token candidates every few cycles using web search, news, social media (X/Twitter), and any available data source.
- Look for: trending Solana tokens, high-volume movers, newly listed tokens with strong liquidity, narrative-driven plays.
- Verify candidates via Jupiter Price API (liquidity >= $2M) before adding to watchlist.
- Aim to maintain 8-12 tokens on the watchlist for broader opportunity coverage.

## Token Watchlist
- SOL: So11111111111111111111111111111111111111112 (decimals 9)
- USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (decimals 6)
- JUP: JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN (decimals 6)
- BONK: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 (decimals 5)

## Lessons Learned
- USDC parking/scalp round-trips are low-volatility and consistently small-PnL positive.
- JUP/BONK trades perform best with quick profit-taking.
- For defensive USDC scalps, target ~99.8%-99.9% sell size (leave minimal dust) for reliable routing.
- After a red scalp exit, wait at least one cycle before re-entering the same trade.
- Back-to-back re-entries after a loss compound risk; take a breather.

## Perp Lessons Learned

## Perp Entry Rules
- If BONK underperforms SOL by >=2 percentage points on 24h change and BONK liquidity stays above $2M, prefer a small 2x BONK short perp over new spot alt longs.
