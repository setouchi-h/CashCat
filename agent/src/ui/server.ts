import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ui");

const DEFAULT_LEDGER_PATH = "/tmp/cashcat-runtime/wallet-mcp/ledger.jsonl";
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface Snapshot {
  now: string;
  mode: "paper" | "live";
  plannerMode: string;
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
  queues: {
    pendingIntents: number;
    processedIntents: number;
    resultFiles: number;
  };
  recentResults: Array<{
    file: string;
    status?: string;
    intentId?: string;
    createdAt?: string;
    txHash?: string;
    inputAmount?: string;
    outputAmount?: string;
    error?: string;
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

function sanitizePath(value: string): string {
  return value.trim();
}

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
  if (!Number.isFinite(raw) || !Number.isFinite(divisor) || divisor <= 0) {
    return 0;
  }
  return raw / divisor;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function getLatestPriceUsd(
  marketHistory: Record<string, unknown>,
  mint: string
): number {
  const points = marketHistory[mint];
  if (!Array.isArray(points) || points.length === 0) return 0;
  const last = points.at(-1);
  if (!last || typeof last !== "object") return 0;
  const value = Number((last as Record<string, unknown>).priceUsd ?? 0);
  return Number.isFinite(value) ? value : 0;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listJsonFiles(targetDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(targetDir, entry.name));
  } catch {
    return [];
  }
}

async function sortByMtimeDesc(paths: string[]): Promise<string[]> {
  const withStats = await Promise.all(
    paths.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        return { filePath, mtimeMs: 0 };
      }
    })
  );

  return withStats
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((item) => item.filePath);
}

async function loadRecentResults(
  resultDir: string,
  limit = 20
): Promise<Snapshot["recentResults"]> {
  const files = await sortByMtimeDesc(await listJsonFiles(resultDir));
  const selected = files.slice(0, limit);

  return await Promise.all(
    selected.map(async (filePath) => {
      const file = path.basename(filePath);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
          file,
          status:
            typeof parsed.status === "string" ? parsed.status : undefined,
          intentId:
            typeof parsed.intentId === "string" ? parsed.intentId : undefined,
          createdAt:
            typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
          txHash: typeof parsed.txHash === "string" ? parsed.txHash : undefined,
          inputAmount:
            typeof parsed.inputAmount === "string" ? parsed.inputAmount : undefined,
          outputAmount:
            typeof parsed.outputAmount === "string" ? parsed.outputAmount : undefined,
          error: typeof parsed.error === "string" ? parsed.error : undefined,
        };
      } catch {
        return { file, error: "Failed to parse result json" };
      }
    })
  );
}

async function loadRecentLedger(
  ledgerPath: string,
  limit = 25
): Promise<Snapshot["recentLedger"]> {
  try {
    const raw = await fs.readFile(ledgerPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

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
            timestamp:
              typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
            type: typeof parsed.type === "string" ? parsed.type : undefined,
            payload: {
              intentId:
                typeof payload.intentId === "string" ? payload.intentId : undefined,
              txHash: typeof payload.txHash === "string" ? payload.txHash : undefined,
              inputMint:
                typeof payload.inputMint === "string"
                  ? payload.inputMint
                  : undefined,
              outputMint:
                typeof payload.outputMint === "string"
                  ? payload.outputMint
                  : undefined,
              inputAmount:
                typeof payload.inputAmount === "string"
                  ? payload.inputAmount
                  : undefined,
              outputAmount:
                typeof payload.outputAmount === "string"
                  ? payload.outputAmount
                  : undefined,
            },
          };
        } catch {
          return {
            type: "parse_error",
            payload: { intentId: undefined },
          };
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

async function loadSnapshot(): Promise<Snapshot> {
  const statePath = sanitizePath(config.runtime.agentic.statePath);
  const intentDir = sanitizePath(config.runtime.intentDir);
  const resultDir = sanitizePath(config.runtime.resultDir);
  const ledgerPath = sanitizePath(
    process.env.WALLET_MCP_LEDGER_PATH ?? DEFAULT_LEDGER_PATH
  );

  let cycle = 0;
  let solPriceUsd = 0;
  let cashSol = 0;
  let cashUsd = 0;
  let realizedSol = 0;
  let realizedUsd = 0;
  let unrealizedUsd = 0;
  let equityUsd = 0;
  let initialEquityUsd = 0;
  let totalPnlUsd = 0;
  let totalPnlPct = 0;
  let filledCount = 0;
  let failedCount = 0;
  let positions: Snapshot["positions"] = [];

  if (await fileExists(statePath)) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const state = JSON.parse(raw) as Record<string, unknown>;
      const marketHistory = toRecord(state.marketHistory);
      cycle = Number(state.cycle ?? 0) || 0;
      solPriceUsd = getLatestPriceUsd(marketHistory, SOL_MINT);
      cashSol = lamportsToSol(state.cashLamports);
      cashUsd = cashSol * solPriceUsd;
      realizedSol = lamportsToSol(state.realizedPnlLamports);
      realizedUsd = realizedSol * solPriceUsd;
      filledCount = Number(state.filledCount ?? 0) || 0;
      failedCount = Number(state.failedCount ?? 0) || 0;

      const rawPositions =
        state.positions && typeof state.positions === "object"
          ? (state.positions as Record<string, unknown>)
          : {};
      positions = Object.values(rawPositions)
        .filter((value) => value && typeof value === "object")
        .map((value) => {
          const p = value as Record<string, unknown>;
          const decimals = Number(p.decimals ?? 0) || 0;
          const quantity = tokenRawToAmount(p.rawAmount, decimals);
          const latestPrice = getLatestPriceUsd(
            marketHistory,
            typeof p.mint === "string" ? p.mint : ""
          );
          const marketValueUsd = quantity * latestPrice;
          const costUsd = lamportsToSol(p.costLamports) * solPriceUsd;
          const unrealizedPnlUsd = marketValueUsd - costUsd;
          return {
            mint: typeof p.mint === "string" ? p.mint : "",
            symbol: typeof p.symbol === "string" ? p.symbol : "",
            rawAmount: typeof p.rawAmount === "string" ? p.rawAmount : "0",
            decimals,
            quantity,
            latestPriceUsd: latestPrice,
            marketValueUsd,
            costUsd,
            unrealizedPnlUsd,
            costLamports:
              typeof p.costLamports === "string" ? p.costLamports : "0",
            openedAt: typeof p.openedAt === "string" ? p.openedAt : "",
            updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
          };
        });

      unrealizedUsd = positions.reduce(
        (sum, position) => sum + position.unrealizedPnlUsd,
        0
      );
      const positionValueUsd = positions.reduce(
        (sum, position) => sum + position.marketValueUsd,
        0
      );
      equityUsd = cashUsd + positionValueUsd;
      const initialCashLamportsStr =
        typeof state.initialCashLamports === "string" && state.initialCashLamports
          ? state.initialCashLamports
          : undefined;
      const initialCashSol = initialCashLamportsStr
        ? lamportsToSol(initialCashLamportsStr)
        : config.runtime.agentic.initialCashSol;
      initialEquityUsd = initialCashSol * solPriceUsd;
      totalPnlUsd = equityUsd - initialEquityUsd;
      totalPnlPct =
        initialEquityUsd > 0 ? (totalPnlUsd / initialEquityUsd) * 100 : 0;
    } catch (e) {
      log.warn(`Failed to parse state: ${String(e)}`);
    }
  }

  const [pendingIntents, processedIntents, results, recentResults, recentLedger] =
    await Promise.all([
      listJsonFiles(intentDir),
      listJsonFiles(path.join(intentDir, "_processed")),
      listJsonFiles(resultDir),
      loadRecentResults(resultDir, 20),
      loadRecentLedger(ledgerPath, 25),
    ]);

  return {
    now: new Date().toISOString(),
    mode: config.paperTrade ? "paper" : "live",
    plannerMode: config.runtime.agentic.plannerMode,
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
    queues: {
      pendingIntents: pendingIntents.length,
      processedIntents: processedIntents.length,
      resultFiles: results.length,
    },
    recentResults,
    recentLedger,
  };
}

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
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
    }
    .k { color: var(--muted); font-size: 11px; margin-bottom: 3px; }
    .v { font-size: 18px; font-weight: 700; }
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
    .pill {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .mini { font-size: 11px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>CashCat Runtime Dashboard</h1>
    <div class="sub">Auto refresh: 3s | Endpoint: <span class="mono">/api/snapshot</span> | PnL is paper estimation from state + latest prices</div>
    <div class="grid" id="metrics"></div>
    <div class="row">
      <div class="card">
        <div class="k">Positions</div>
        <div id="positions"></div>
      </div>
      <div class="card">
        <div class="k">Queues / Files</div>
        <div id="queues"></div>
      </div>
      <div class="card">
        <div class="k">Recent Results</div>
        <div id="results"></div>
      </div>
      <div class="card">
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
    function metricsHtml(s) {
      return [
        ["Mode", s.mode],
        ["Planner", s.plannerMode],
        ["Cycle", s.cycle],
        ["SOL Price (USD)", "$" + fmt(s.solPriceUsd, 4)],
        ["Cash (SOL)", fmt(s.cashSol)],
        ["Cash (USD)", "$" + fmt(s.cashUsd, 2)],
        ["Realized (SOL)", fmt(s.realizedSol, 6), s.realizedSol >= 0 ? "ok" : "danger"],
        ["Realized (USD)", "$" + money(s.realizedUsd), s.realizedUsd >= 0 ? "ok" : "danger"],
        ["Unrealized (USD)", "$" + money(s.unrealizedUsd), s.unrealizedUsd >= 0 ? "ok" : "danger"],
        ["Total PnL (USD)", "$" + money(s.totalPnlUsd), s.totalPnlUsd >= 0 ? "ok" : "danger"],
        ["Total PnL (%)", fmt(s.totalPnlPct, 2) + "%", s.totalPnlPct >= 0 ? "ok" : "danger"],
        ["Equity (USD)", "$" + fmt(s.equityUsd, 2)],
        ["Open Positions", s.openPositions],
        ["Filled", s.filledCount, "ok"],
        ["Failed", s.failedCount, s.failedCount > 0 ? "danger" : ""]
      ].map(([k,v,cls]) => \`<div class="card"><div class="k">\${k}</div><div class="v \${cls || ""}">\${esc(v)}</div></div>\`).join("");
    }
    function positionsHtml(items) {
      if (!items || items.length === 0) return '<div class="mini">No open positions</div>';
      return '<table><thead><tr><th>Symbol</th><th>Qty</th><th>Px(USD)</th><th>Value(USD)</th><th>Unrealized(USD)</th></tr></thead><tbody>' +
        items.map((p) => \`<tr><td>\${esc(p.symbol)}</td><td class="mono">\${fmt(p.quantity, 6)}</td><td>\$ \${fmt(p.latestPriceUsd, 6)}</td><td>\$ \${fmt(p.marketValueUsd, 2)}</td><td class="\${p.unrealizedPnlUsd >= 0 ? "ok" : "danger"}">\$ \${money(p.unrealizedPnlUsd)}</td></tr>\`).join("") +
        "</tbody></table>";
    }
    function queuesHtml(q) {
      return '<div class="mini">' +
        \`pendingIntents=<span class="pill">\${esc(q.pendingIntents)}</span> \` +
        \`processedIntents=<span class="pill">\${esc(q.processedIntents)}</span> \` +
        \`resultFiles=<span class="pill">\${esc(q.resultFiles)}</span>\` +
        "</div>";
    }
    function resultsHtml(items) {
      if (!items || items.length === 0) return '<div class="mini">No result files</div>';
      return '<table><thead><tr><th>Status</th><th>Intent</th><th>Tx</th><th>Time</th><th>Error</th></tr></thead><tbody>' +
        items.map((r) => \`<tr><td>\${esc(r.status || "-")}</td><td class="mono">\${esc(r.intentId || "-")}</td><td class="mono">\${esc(r.txHash || "-")}</td><td>\${esc(r.createdAt || "-")}</td><td>\${esc(r.error || "")}</td></tr>\`).join("") +
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
        document.getElementById('metrics').innerHTML = metricsHtml(s);
        document.getElementById('positions').innerHTML = positionsHtml(s.positions);
        document.getElementById('queues').innerHTML = queuesHtml(s.queues);
        document.getElementById('results').innerHTML = resultsHtml(s.recentResults);
        document.getElementById('ledger').innerHTML = ledgerHtml(s.recentLedger);
      } catch (e) {
        document.getElementById('queues').innerHTML = '<span class="danger">Failed to load snapshot</span>';
      }
    }
    tick();
    setInterval(tick, 3000);
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/api/snapshot") {
    const snapshot = await loadSnapshot();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(snapshot));
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

server.listen(PORT, "127.0.0.1", () => {
  log.info(`Dashboard running: http://127.0.0.1:${PORT}`);
});
