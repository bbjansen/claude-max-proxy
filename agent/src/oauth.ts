import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthCredential } from "./types.js";

const DEFAULT_EXPIRES_IN_S = 8 * 3600;

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const SCOPES = "user:inference user:profile user:mcp_servers user:file_upload user:sessions:claude_code";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SCOPES);
  return u.toString();
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri: string,
  opts: { nowMs?: () => number } = {},
): Promise<OAuthCredential> {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`exchange ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json() as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    throw new Error("exchange response missing access_token");
  }
  const newRefreshToken = typeof json.refresh_token === "string" ? json.refresh_token : "";
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : DEFAULT_EXPIRES_IN_S;
  const scope = typeof json.scope === "string" ? json.scope : "";
  return {
    accessToken: json.access_token,
    refreshToken: newRefreshToken,
    expiresAt: nowMs() + expiresIn * 1000,
    scopes: scope.split(" ").filter(Boolean),
  };
}

const CALLBACK_PATH = "/callback";
const SUCCESS_HTML = "<html><body><h1>Login successful</h1><p>You can close this tab.</p></body></html>";

export async function startCallbackServer(
  expectedState: string,
  opts: { port?: number } = {},
): Promise<{ redirectUri: string; result: Promise<{ code: string }>; close: () => void }> {
  let resolveResult!: (v: { code: string }) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<{ code: string }>((res, rej) => {
    resolveResult = res; rejectResult = rej;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (state !== expectedState) {
      res.statusCode = 400;
      res.end("OAuth state mismatch");
      rejectResult(new Error("OAuth state mismatch"));
      server.close();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html");
    res.end(SUCCESS_HTML);
    resolveResult({ code });
    server.close();
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const close = () => { try { server.close(); } catch { /* ignore */ } };
  return { redirectUri, result, close };
}
