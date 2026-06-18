import { describe, it, expect } from "vitest";
import { runLogin } from "../src/login.js";
import type { OAuthCredential } from "../src/types.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

describe("runLogin", () => {
  it("opens the browser, awaits the callback, exchanges code, writes credential", async () => {
    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const s = typeof url === "string" ? url : url.toString();
      if (s.startsWith(TOKEN_URL)) {
        tokenCalls++;
        return new Response(JSON.stringify({
          access_token: "sk-ant-oat01-NEW",
          refresh_token: "sk-ant-ort01-NEW",
          expires_in: 3600,
          scope: "user:inference user:profile",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Forward everything else (e.g. the local callback fetch) to real fetch.
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    const writes: Array<{ acctId: string; cred: OAuthCredential }> = [];
    let authorizeUrl = "";

    const openBrowser = async (url: string) => {
      authorizeUrl = url;
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const redirectUri = u.searchParams.get("redirect_uri")!;
      const cb = new URL(redirectUri);
      cb.searchParams.set("code", "FAKE_CODE");
      cb.searchParams.set("state", state);
      setTimeout(() => { originalFetch(cb.toString()).catch(() => {}); }, 0);
    };

    try {
      await runLogin("user@example.com", {
        openBrowser,
        writeCredential: async (acctId, cred) => { writes.push({ acctId, cred }); },
        nowMs: () => 1_700_000_000_000,
      });

      expect(authorizeUrl).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      expect(authorizeUrl).toContain("code_challenge_method=S256");
      expect(tokenCalls).toBe(1);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.acctId).toBe("user@example.com");
      expect(writes[0]!.cred.accessToken).toBe("sk-ant-oat01-NEW");
      expect(writes[0]!.cred.expiresAt).toBe(1_700_000_000_000 + 3600 * 1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects without writing when the upstream code exchange fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const s = typeof url === "string" ? url : url.toString();
      if (s.startsWith(TOKEN_URL)) {
        return new Response("bad_grant", { status: 400 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;
    const writes: unknown[] = [];

    const openBrowser = async (url: string) => {
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("code", "FAKE");
      cb.searchParams.set("state", state);
      setTimeout(() => { originalFetch(cb.toString()).catch(() => {}); }, 0);
    };

    try {
      await expect(runLogin("u@x.com", {
        openBrowser,
        writeCredential: async () => { writes.push(true); },
      })).rejects.toThrow(/exchange 400/);
      expect(writes).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
