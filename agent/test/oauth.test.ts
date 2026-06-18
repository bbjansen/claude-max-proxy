import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generatePkcePair,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  CLIENT_ID,
  AUTHORIZE_URL,
  SCOPES,
} from "../src/oauth.js";
import { createHash } from "node:crypto";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

describe("generatePkcePair", () => {
  it("returns a 64-char base64url verifier and a SHA-256 base64url challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(BASE64URL_RE);
    expect(challenge).toMatch(BASE64URL_RE);
    const want = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(want);
  });

  it("produces distinct verifiers across calls", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("generateState", () => {
  it("returns a base64url state of at least 32 chars", () => {
    const s = generateState();
    expect(s.length).toBeGreaterThanOrEqual(32);
    expect(s).toMatch(BASE64URL_RE);
  });
});

describe("buildAuthorizeUrl", () => {
  it("encodes all OAuth params on the authorize URL", () => {
    const url = new URL(buildAuthorizeUrl("CHALL", "STATE", "http://127.0.0.1:54321/callback"));
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("CHALL");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    expect(url.searchParams.get("scope")).toBe(SCOPES);
  });
});

describe("exchangeCodeForTokens", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("POSTs JSON to the token endpoint with the right grant + fields", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "sk-ant-oat01-X",
      refresh_token: "sk-ant-ort01-X",
      expires_in: 3600,
      scope: "user:inference user:profile",
      token_type: "Bearer",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const NOW = 1_700_000_000_000;
    const cred = await exchangeCodeForTokens("CODE", "VERIFIER", "http://127.0.0.1:54321/callback", { nowMs: () => NOW });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      grant_type: "authorization_code",
      code: "CODE",
      code_verifier: "VERIFIER",
      redirect_uri: "http://127.0.0.1:54321/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
    expect(cred.accessToken).toBe("sk-ant-oat01-X");
    expect(cred.refreshToken).toBe("sk-ant-ort01-X");
    expect(cred.expiresAt).toBe(NOW + 3600 * 1000);
    expect(cred.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("throws on non-2xx with status and body slice in the message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oh no: invalid_grant", { status: 400 }));
    await expect(
      exchangeCodeForTokens("CODE", "V", "http://127.0.0.1/cb")
    ).rejects.toThrow(/exchange 400.*invalid_grant/);
  });

  it("throws when the response is missing access_token", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: "x" }), { status: 200 }));
    await expect(
      exchangeCodeForTokens("CODE", "V", "http://127.0.0.1/cb")
    ).rejects.toThrow(/access_token/);
  });
});
