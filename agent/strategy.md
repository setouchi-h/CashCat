# CashCat Trading Strategy

(Codex reads and writes this file to evolve its trading strategy)
(RULES: Only write durable rules and lessons here. Per-cycle market data goes in observations.md. Keep under 50 lines.)

## Entry Rules
- Trade only tokens with Jupiter liquidity >= $2M.
- Prefer relative strength: token 24h change should be at least 3pp better than SOL.
- Avoid fresh buys when SOL is below -8% 24h unless token is near flat or green.
- Keep initial risk small: 0.1-0.25 SOL per entry.

## Exit Rules
- Let engine-managed TP/SL/timeout handle exits; do not add discretionary stop orders.
- For momentum names, favor single-cycle or short-hold exits over averaging down.

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
- Avoid exact full-balance sells; leave dust to reduce Jupiter route simulation failures (0x1788 seen on 2026-02-23).
- USDC parking/scalp round-trips are low-volatility and consistently small-PnL positive.
- JUP/BONK trades perform best with quick profit-taking; avoid adding size during broad SOL-led drawdowns.
- During sharp SOL drawdowns (~-9% to -10% 24h), defensive SOL->USDC rotations are preferable to opening fresh alt positions.
- When SOL remains below -10% on 24h momentum, keep defensive USDC entries small (0.2 SOL clip) to preserve flexibility for later adds/exits.
- Quick defensive USDC round-trips during >10% SOL drawdowns can realize small gains; keep using partial-size entries/exits instead of all-in flips.
- In fast tape, near-full (not exact-full) USDC exits after 0.2 SOL defensive entries continue to lock in small realized gains while avoiding sell-route edge-case failures.
- For defensive USDC scalps, target ~99.8%-99.9% sell size (leave minimal dust) to balance reliable routing and profit capture.
- During sustained >11% SOL 24h weakness, short-hold (few-minute) USDC defensive scalps remain effective when entered small (0.2 SOL) and exited on the next relief bounce.
- After a defensive USDC scalp exits red, avoid immediate re-entry without a fresh SOL momentum bounce confirmation.
- If SOL 24h momentum only recovers to around -10% after a >11% drawdown, keep USDC defensive positions as short holds and avoid multi-cycle overstays.
- When SOL rebounds from >11% down toward ~-10% but fails to trend, pause new USDC defensive re-entries because scalp edge degrades in choppy relief.
- Back-to-back USDC defensive re-entries after the first red scalp in the same weak regime can compound losses; wait for a clearer momentum turn before retrying.
- When SOL sits near -10% 24h without clear trend expansion, defensive USDC scalp churn has weak edge; prefer no-trade over repeated round-trips.
- If SOL re-extends to about -11% 24h after a flat/no-position stretch, a single small (0.2 SOL) USDC defensive entry is acceptable, but avoid stacking additional entries before a bounce.
- After a small defensive USDC entry, if SOL is still around -10.5% 24h and fails to bounce quickly, avoid forcing the exit scalp; churn risk rises and edge turns negative.
- After a red 0.2 SOL USDC defensive scalp in -10% to -11% SOL momentum, stand down for at least one full cycle before considering another defensive re-entry.
- If a 0.2 SOL USDC defensive scalp exits red during flat ~-10% SOL momentum, pause new defensive entries until SOL 24h trend clearly improves.
