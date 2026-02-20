import * as crypto from "node:crypto";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("oauth");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPES = "openid profile email offline_access";

const TOKEN_FILE = path.join(
  process.env.HOME ?? ".",
  ".cashcat",
  "openai-tokens.json"
);

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function loadTokens(): StoredTokens | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    return data as StoredTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: StoredTokens): void {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
  log.info("Tokens saved");
}

async function exchangeCode(
  code: string,
  codeVerifier: string
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(
      `Token exchange failed: ${res.status} ${await res.text()}`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

async function refreshAccessToken(
  refreshToken: string
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(
      `Token refresh failed: ${res.status} ${await res.text()}`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

function waitForCallback(
  codeVerifier: string
): Promise<StoredTokens> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400);
          res.end(`Auth error: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end("No code received");
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }

        const tokens = await exchangeCode(code, codeVerifier);
        saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>CashCat: Authentication successful!</h1><p>You can close this tab.</p>");
        server.close();
        resolve(tokens);
      } catch (e) {
        res.writeHead(500);
        res.end("Token exchange failed");
        server.close();
        reject(e);
      }
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      log.info(`Callback server listening on port ${REDIRECT_PORT}`);
    });

    server.on("error", (e) => {
      reject(new Error(`Could not start callback server: ${e.message}`));
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timeout (2 minutes)"));
    }, 120_000);
  });
}

export async function loginWithOAuth(): Promise<StoredTokens> {
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "cashcat",
  });

  const authUrl = `${AUTH_URL}?${params.toString()}`;

  console.log("\n=== ChatGPT OAuth Login ===");
  console.log("Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nWaiting for authentication...\n");

  return waitForCallback(verifier);
}

export async function getAccessToken(): Promise<string> {
  let tokens = loadTokens();

  if (!tokens) {
    log.info("No stored tokens, starting OAuth login...");
    tokens = await loginWithOAuth();
  }

  // Refresh if expiring within 5 minutes
  if (tokens.expires_at - Date.now() < 5 * 60 * 1000) {
    log.info("Token expiring soon, refreshing...");
    try {
      tokens = await refreshAccessToken(tokens.refresh_token);
      saveTokens(tokens);
    } catch (e) {
      log.warn("Token refresh failed, re-authenticating...", e);
      tokens = await loginWithOAuth();
    }
  }

  return tokens.access_token;
}
