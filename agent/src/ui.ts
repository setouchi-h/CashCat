import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("ui");

const DEFAULT_LEDGER_PATH = "/tmp/cashcat-runtime/wallet-mcp/ledger.jsonl";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Snapshot {
  now: string;
  cycle: number;
  solPriceUsd: number;
  cashSol: number;
  cashUsd: number;
  realizedSol: number;
  realizedUsd: number;
  unrealizedUsd: number;
  equityUsd: number;
  initialEquityUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  filledCount: number;
  failedCount: number;
  openPositions: number;
  positions: Array<{
    mint: string;
    symbol: string;
    rawAmount: string;
    decimals: number;
    quantity: number;
    latestPriceUsd: number;
    marketValueUsd: number;
    costUsd: number;
    unrealizedPnlUsd: number;
    costLamports: string;
    openedAt: string;
    updatedAt: string;
  }>;
  perpBalanceUsd: number;
  realizedPerpPnlUsd: number;
  perpPositions: Array<{
    market: string;
    side: string;
    leverage: number;
    sizeUsd: number;
    collateralUsd: number;
    entryPriceUsd: number;
    markPriceUsd: number;
    liquidationPriceUsd: number;
    unrealizedPnlUsd: number;
    borrowFeeUsd: number;
    openedAt: string;
  }>;
  recentLedger: Array<{
    timestamp?: string;
    type?: string;
    payload?: {
      intentId?: string;
      txHash?: string;
      inputMint?: string;
      outputMint?: string;
      inputAmount?: string;
      outputAmount?: string;
    };
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBigInt(value: unknown): bigint {
  if (typeof value !== "string" && typeof value !== "number") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function lamportsToSol(value: unknown): number {
  return Number(toBigInt(value)) / 1_000_000_000;
}

function tokenRawToAmount(rawAmount: unknown, decimals: number): number {
  const raw = Number(toBigInt(rawAmount));
  const divisor = 10 ** Math.max(0, decimals);
  if (!Number.isFinite(raw) || !Number.isFinite(divisor) || divisor <= 0) return 0;
  return raw / divisor;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Price fetching for dashboard
// ---------------------------------------------------------------------------

function buildPriceUrl(mints: string[]): string {
  const url = new URL(`${config.jupiter.baseUrl}/price/v3`);
  url.searchParams.set("ids", mints.join(","));
  return url.toString();
}

async function fetchPricesUsd(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  try {
    const response = await fetch(buildPriceUrl(mints));
    if (!response.ok) return {};
    const payload = (await response.json()) as Record<string, unknown> | { data?: Record<string, unknown> };
    const data: Record<string, unknown> =
      payload && typeof payload === "object" && "data" in payload && payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : (payload as Record<string, unknown>);
    const prices: Record<string, number> = {};
    for (const mint of mints) {
      const row = data[mint] as Record<string, unknown> | undefined;
      const price = Number(row?.usdPrice ?? row?.price ?? row?.priceUsd ?? row?.value ?? 0);
      prices[mint] = Number.isFinite(price) && price > 0 ? price : 0;
    }
    return prices;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

async function loadRecentLedger(ledgerPath: string, limit = 25): Promise<Snapshot["recentLedger"]> {
  try {
    const raw = await fs.readFile(ledgerPath, "utf8");
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const payload =
            parsed.payload && typeof parsed.payload === "object"
              ? (parsed.payload as Record<string, unknown>)
              : {};
          return {
            timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
            type: typeof parsed.type === "string" ? parsed.type : undefined,
            payload: {
              intentId: typeof payload.intentId === "string" ? payload.intentId : undefined,
              txHash: typeof payload.txHash === "string" ? payload.txHash : undefined,
              inputMint: typeof payload.inputMint === "string" ? payload.inputMint : undefined,
              outputMint: typeof payload.outputMint === "string" ? payload.outputMint : undefined,
              inputAmount: typeof payload.inputAmount === "string" ? payload.inputAmount : undefined,
              outputAmount: typeof payload.outputAmount === "string" ? payload.outputAmount : undefined,
            },
          };
        } catch {
          return { type: "parse_error", payload: { intentId: undefined } };
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

async function loadSnapshot(): Promise<Snapshot> {
  const ledgerPath = (process.env.WALLET_MCP_LEDGER_PATH ?? DEFAULT_LEDGER_PATH).trim();

  let cycle = 0;
  let cashSol = 0;
  let realizedSol = 0;
  let filledCount = 0;
  let failedCount = 0;
  let positions: Snapshot["positions"] = [];
  let initialCashSol = config.initialCashSol;

  let state: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(config.statePath, "utf8");
    state = JSON.parse(raw) as Record<string, unknown>;
    cycle = Number(state.cycle ?? 0) || 0;
    cashSol = lamportsToSol(state.cashLamports);
    realizedSol = lamportsToSol(state.realizedPnlLamports);
    filledCount = Number(state.filledCount ?? 0) || 0;
    failedCount = Number(state.failedCount ?? 0) || 0;

    if (typeof state.initialCashLamports === "string" && state.initialCashLamports) {
      initialCashSol = lamportsToSol(state.initialCashLamports);
    }

    const rawPositions = state.positions && typeof state.positions === "object"
      ? (state.positions as Record<string, unknown>)
      : {};
    positions = Object.values(rawPositions)
      .filter((v) => v && typeof v === "object")
      .map((v) => {
        const p = v as Record<string, unknown>;
        const decimals = Number(p.decimals ?? 0) || 0;
        const quantity = tokenRawToAmount(p.rawAmount, decimals);
        return {
          mint: typeof p.mint === "string" ? p.mint : "",
          symbol: typeof p.symbol === "string" ? p.symbol : "",
          rawAmount: typeof p.rawAmount === "string" ? p.rawAmount : "0",
          decimals,
          quantity,
          latestPriceUsd: 0,
          marketValueUsd: 0,
          costUsd: 0,
          unrealizedPnlUsd: 0,
          costLamports: typeof p.costLamports === "string" ? p.costLamports : "0",
          openedAt: typeof p.openedAt === "string" ? p.openedAt : "",
          updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
        };
      });
  } catch {
    // state file not yet created
  }

  // Read perp state
  const perpBalanceUsd = Number(state.perpBalanceUsd ?? 0) || 0;
  const realizedPerpPnlUsd = Number(state.realizedPerpPnlUsd ?? 0) || 0;
  const rawPerpPositions = state.perpPositions && typeof state.perpPositions === "object"
    ? (state.perpPositions as Record<string, unknown>)
    : {};

  // Collect all mints we need prices for (spot + perp underlyings)
  const perpEntries = Object.values(rawPerpPositions)
    .filter((v) => v && typeof v === "object")
    .map((v) => v as Record<string, unknown>);
  const perpUnderlyingMints = perpEntries
    .map((p) => typeof p.underlyingMint === "string" ? p.underlyingMint : "")
    .filter(Boolean);

  const allMints = [SOL_MINT, ...positions.map((p) => p.mint).filter(Boolean), ...perpUnderlyingMints];
  const prices = await fetchPricesUsd([...new Set(allMints)]);
  const solPriceUsd = prices[SOL_MINT] ?? 0;

  // Enrich spot positions with price data
  for (const p of positions) {
    p.latestPriceUsd = prices[p.mint] ?? 0;
    p.marketValueUsd = p.quantity * p.latestPriceUsd;
    p.costUsd = lamportsToSol(p.costLamports) * solPriceUsd;
    p.unrealizedPnlUsd = p.marketValueUsd - p.costUsd;
  }

  // Build perp positions with unrealized PnL
  const nowMs = Date.now();
  const hourlyBorrowRate = 0.0000125; // matches config default
  const perpPositions: Snapshot["perpPositions"] = perpEntries.map((p) => {
    const side = typeof p.side === "string" ? p.side : "long";
    const entryPriceUsd = Number(p.entryPriceUsd ?? 0) || 0;
    const sizeUsd = Number(p.sizeUsd ?? 0) || 0;
    const collateralUsd = Number(p.collateralUsd ?? 0) || 0;
    const underlyingMint = typeof p.underlyingMint === "string" ? p.underlyingMint : "";
    const markPriceUsd = prices[underlyingMint] ?? 0;
    const holdHours = Math.max(0, (nowMs - Date.parse(typeof p.openedAt === "string" ? p.openedAt : "")) / 3_600_000);
    const borrowFeeUsd = sizeUsd * hourlyBorrowRate * holdHours;
    let unrealizedPnlUsd = 0;
    if (entryPriceUsd > 0 && markPriceUsd > 0) {
      const priceChange = (markPriceUsd - entryPriceUsd) / entryPriceUsd;
      const rawPnl = side === "long" ? sizeUsd * priceChange : sizeUsd * -priceChange;
      unrealizedPnlUsd = rawPnl - borrowFeeUsd;
    }
    return {
      market: typeof p.market === "string" ? p.market : "",
      side,
      leverage: Number(p.leverage ?? 1) || 1,
      sizeUsd,
      collateralUsd,
      entryPriceUsd,
      markPriceUsd,
      liquidationPriceUsd: Number(p.liquidationPriceUsd ?? 0) || 0,
      unrealizedPnlUsd,
      borrowFeeUsd,
      openedAt: typeof p.openedAt === "string" ? p.openedAt : "",
    };
  });

  const cashUsd = cashSol * solPriceUsd;
  const realizedUsd = realizedSol * solPriceUsd;
  const unrealizedUsd = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const perpUnrealizedUsd = perpPositions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const positionValueUsd = positions.reduce((s, p) => s + p.marketValueUsd, 0);
  const equityUsd = cashUsd + positionValueUsd + perpBalanceUsd + perpUnrealizedUsd;
  const initialEquityUsd = initialCashSol * solPriceUsd;
  const totalPnlUsd = equityUsd - initialEquityUsd;
  const totalPnlPct = initialEquityUsd > 0 ? (totalPnlUsd / initialEquityUsd) * 100 : 0;

  const recentLedger = await loadRecentLedger(ledgerPath, 25);

  return {
    now: new Date().toISOString(),
    cycle,
    solPriceUsd,
    cashSol,
    cashUsd,
    realizedSol,
    realizedUsd,
    unrealizedUsd,
    equityUsd,
    initialEquityUsd,
    totalPnlUsd,
    totalPnlPct,
    filledCount,
    failedCount,
    openPositions: positions.length,
    positions,
    perpBalanceUsd,
    realizedPerpPnlUsd,
    perpPositions,
    recentLedger,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function htmlPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CashCat Dashboard</title>
  <style>
    :root {
      --bg: #0b1217;
      --panel: #101b22;
      --muted: #8ea2b2;
      --text: #d9e6ef;
      --ok: #36c689;
      --warn: #f7c65e;
      --danger: #ff7d6b;
      --line: #1d2b35;
      --accent: #4db7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background:
        radial-gradient(1000px 400px at 20% -10%, #12364c 0%, transparent 60%),
        radial-gradient(800px 350px at 100% 0%, #2a1e2f 0%, transparent 55%),
        var(--bg);
      color: var(--text);
    }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    .sub { color: var(--muted); margin-bottom: 16px; font-size: 12px; }
    .section { margin-bottom: 16px; }
    .section-title { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; padding-left: 2px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
    }
    .card-hero {
      background: linear-gradient(135deg, #131f2b 0%, #1a2836 100%);
      border: 1px solid #2a3f50;
    }
    .k { color: var(--muted); font-size: 11px; margin-bottom: 3px; }
    .v { font-size: 18px; font-weight: 700; }
    .v-lg { font-size: 24px; font-weight: 700; }
    .ok { color: var(--ok); }
    .danger { color: var(--danger); }
    .warn { color: var(--warn); }
    .row {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    @media (min-width: 980px) {
      .row { grid-template-columns: 1fr 1fr; }
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      text-align: left;
      padding: 6px 4px;
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    .mono { font-family: inherit; }
    .mini { font-size: 11px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>CashCat Runtime Dashboard</h1>
    <div class="sub">Auto refresh: 3s | Endpoint: <span class="mono">/api/snapshot</span> | PnL is estimation from state + latest prices</div>
    <div id="overview" class="section"></div>
    <div id="spot" class="section"></div>
    <div id="perp" class="section"></div>
    <div class="section">
      <div class="section-title">Execution</div>
      <div class="grid" id="execution"></div>
    </div>
    <div class="row">
      <div class="card">
        <div class="k">Spot Positions</div>
        <div id="positions"></div>
      </div>
      <div class="card">
        <div class="k">Perp Positions</div>
        <div id="perpPositions"></div>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <div class="card" style="grid-column:1/-1">
        <div class="k">Recent Ledger</div>
        <div id="ledger"></div>
      </div>
    </div>
  </div>
  <script>
    const fmt = (n, d = 4) => Number(n || 0).toFixed(d);
    const money = (n) => (Number(n || 0) >= 0 ? "+" : "") + Number(n || 0).toFixed(2);
    const esc = (s) => String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    function card(k, v, cls) {
      return \`<div class="card"><div class="k">\${k}</div><div class="v \${cls || ""}">\${esc(v)}</div></div>\`;
    }
    function heroCard(k, v, cls) {
      return \`<div class="card card-hero"><div class="k">\${k}</div><div class="v-lg \${cls || ""}">\${esc(v)}</div></div>\`;
    }
    function sectionHtml(title, cards) {
      return \`<div class="section-title">\${title}</div><div class="grid">\${cards.join("")}</div>\`;
    }
    function overviewHtml(s) {
      return sectionHtml("Overview", [
        heroCard("Total Equity", "$" + fmt(s.equityUsd, 2)),
        heroCard("Total PnL", "$" + money(s.totalPnlUsd), s.totalPnlUsd >= 0 ? "ok" : "danger"),
        heroCard("PnL %", fmt(s.totalPnlPct, 2) + "%", s.totalPnlPct >= 0 ? "ok" : "danger"),
        card("SOL Price", "$" + fmt(s.solPriceUsd, 4)),
        card("Cycle", s.cycle),
      ]);
    }
    function spotHtml(s) {
      return sectionHtml("Spot", [
        card("Cash", fmt(s.cashSol, 4) + " SOL  ($" + fmt(s.cashUsd, 2) + ")"),
        card("Open Positions", s.openPositions),
        card("Unrealized PnL", "$" + money(s.unrealizedUsd), s.unrealizedUsd >= 0 ? "ok" : "danger"),
        card("Realized PnL", "$" + money(s.realizedUsd), s.realizedUsd >= 0 ? "ok" : "danger"),
      ]);
    }
    function perpSectionHtml(s) {
      const perpUnrealized = (s.perpPositions || []).reduce((sum, p) => sum + (p.unrealizedPnlUsd || 0), 0);
      return sectionHtml("Perps", [
        card("Balance", "$" + fmt(s.perpBalanceUsd, 2) + " USDC"),
        card("Open Positions", (s.perpPositions || []).length),
        card("Unrealized PnL", "$" + money(perpUnrealized), perpUnrealized >= 0 ? "ok" : "danger"),
        card("Realized PnL", "$" + money(s.realizedPerpPnlUsd), s.realizedPerpPnlUsd >= 0 ? "ok" : "danger"),
      ]);
    }
    function executionHtml(s) {
      return [
        card("Filled", s.filledCount, "ok"),
        card("Failed", s.failedCount, s.failedCount > 0 ? "danger" : ""),
      ].join("");
    }
    function positionsHtml(items) {
      if (!items || items.length === 0) return '<div class="mini">No open positions</div>';
      return '<table><thead><tr><th>Symbol</th><th>Qty</th><th>Px(USD)</th><th>Value(USD)</th><th>Unrealized(USD)</th></tr></thead><tbody>' +
        items.map((p) => \`<tr><td>\${esc(p.symbol)}</td><td class="mono">\${fmt(p.quantity, 6)}</td><td>\$ \${fmt(p.latestPriceUsd, 6)}</td><td>\$ \${fmt(p.marketValueUsd, 2)}</td><td class="\${p.unrealizedPnlUsd >= 0 ? "ok" : "danger"}">\$ \${money(p.unrealizedPnlUsd)}</td></tr>\`).join("") +
        "</tbody></table>";
    }
    function perpPositionsHtml(items) {
      if (!items || items.length === 0) return '<div class="mini">No open perp positions</div>';
      return '<table><thead><tr><th>Market</th><th>Side</th><th>Lev</th><th>Size($)</th><th>Entry</th><th>Mark</th><th>Liq</th><th>PnL($)</th></tr></thead><tbody>' +
        items.map((p) => \`<tr><td>\${esc(p.market)}</td><td>\${esc(p.side)}</td><td>\${p.leverage}x</td><td>\$ \${fmt(p.sizeUsd, 2)}</td><td>\$ \${fmt(p.entryPriceUsd, 2)}</td><td>\$ \${fmt(p.markPriceUsd, 2)}</td><td>\$ \${fmt(p.liquidationPriceUsd, 2)}</td><td class="\${p.unrealizedPnlUsd >= 0 ? "ok" : "danger"}">\$ \${money(p.unrealizedPnlUsd)}</td></tr>\`).join("") +
        "</tbody></table>";
    }
    function ledgerHtml(items) {
      if (!items || items.length === 0) return '<div class="mini">No ledger entries</div>';
      return '<table><thead><tr><th>Time</th><th>Type</th><th>Intent</th><th>Tx</th></tr></thead><tbody>' +
        items.map((e) => \`<tr><td>\${esc(e.timestamp || "-")}</td><td>\${esc(e.type || "-")}</td><td class="mono">\${esc((e.payload && e.payload.intentId) || "-")}</td><td class="mono">\${esc((e.payload && e.payload.txHash) || "-")}</td></tr>\`).join("") +
        "</tbody></table>";
    }
    async function tick() {
      try {
        const res = await fetch('/api/snapshot', { cache: 'no-store' });
        const s = await res.json();
        document.getElementById('overview').innerHTML = overviewHtml(s);
        document.getElementById('spot').innerHTML = spotHtml(s);
        document.getElementById('perp').innerHTML = perpSectionHtml(s);
        document.getElementById('execution').innerHTML = executionHtml(s);
        document.getElementById('positions').innerHTML = positionsHtml(s.positions);
        document.getElementById('perpPositions').innerHTML = perpPositionsHtml(s.perpPositions);
        document.getElementById('ledger').innerHTML = ledgerHtml(s.recentLedger);
      } catch (e) {
        document.getElementById('ledger').innerHTML = '<span class="danger">Failed to load snapshot</span>';
      }
    }
    tick();
    setInterval(tick, 3000);
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startDashboard(): void {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/snapshot") {
      try {
        const snapshot = await loadSnapshot();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(snapshot));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      }
      return;
    }

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage());
      return;
    }

    if (url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      log.warn(`Dashboard port ${config.dashboardPort} already in use, skipping`);
    } else {
      log.warn(`Dashboard error: ${e.message}`);
    }
  });

  server.listen(config.dashboardPort, "127.0.0.1", () => {
    log.info(`Dashboard running: http://127.0.0.1:${config.dashboardPort}`);
  });
}

// Standalone execution: pnpm dev:ui
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  startDashboard();
}
