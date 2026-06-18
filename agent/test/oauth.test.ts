import { describe, it, expect } from "vitest";
import {
  generatePkcePair,
  generateState,
  buildAuthorizeUrl,
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
