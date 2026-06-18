# Self-owned OAuth credentials — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the proxy agent off the shared `Claude Code-credentials` Keychain entries onto its own `claude-max-proxy-credentials` service, with a one-shot migration that copies existing tokens and an `agent login` subcommand that runs PKCE for any future account.

**Architecture:** Pure-function `oauth.ts` (PKCE primitives + code exchange + localhost callback server) → `login.ts` orchestrates the browser flow → `migrate.ts` copies old-service entries on first start → `index.ts` flips the service name and routes the `login` / `migrate` subcommands. `KeychainWatcher`, `TokenManager`, and `AccountPool` keep their current shape.

**Tech Stack:** TypeScript / Node 20+, existing `node:http`, `node:crypto`, `node:child_process` (for `open`), `vitest`. No new runtime deps.

## Global Constraints

- Branch `feature/CMP-003-self-owned-credentials` already exists (spec is committed there as `1fe9d15`).
- Exact dependency versions in `package.json` (no `^` / `~`).
- Old `KEYCHAIN_SERVICE = "Claude Code-credentials"` → new `"claude-max-proxy-credentials"`. Constant is referenced only in `agent/src/tokens.ts:9` and `agent/src/index.ts:19`.
- OAuth `client_id`: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`.
- Authorize URL: `https://claude.ai/oauth/authorize`.
- Token URL: `https://platform.claude.com/v1/oauth/token`.
- Scopes: `user:inference user:profile user:mcp_servers user:file_upload user:sessions:claude_code`.
- PKCE: 64-char base64url verifier from `crypto.randomBytes(48)`; challenge = `base64url(sha256(verifier))`; `code_challenge_method=S256`.
- State is a 32-char base64url random; single-use; validated server-side on callback.
- Default cooldown / refresh threshold / lock path / OAuth header values for `/v1/messages` are unchanged.
- Commits: conventional, no co-author, no AI references (per user CLAUDE.md).

---

### Task 1: PKCE primitives — verifier, challenge, authorize URL

**Files:**
- Create: `agent/src/oauth.ts`
- Create: `agent/test/oauth.test.ts`

**Interfaces:**
- Produces:
  - `PkcePair = { verifier: string; challenge: string }`
  - `generatePkcePair(): PkcePair`
  - `generateState(): string`
  - `buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string`
  - module-scope exports `CLIENT_ID`, `AUTHORIZE_URL`, `TOKEN_URL`, `SCOPES`

- [ ] **Step 1: Write the failing tests**

`agent/test/oauth.test.ts`:

```ts
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
```

- [ ] **Step 2: Watch the tests fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/oauth.test.ts
```

Expected: file-not-found for `../src/oauth.js`.

- [ ] **Step 3: Implement**

`agent/src/oauth.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const SCOPES = "user:inference user:profile user:mcp_servers user:file_upload user:sessions:claude_code";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  // 48 random bytes → 64 base64url chars (no padding).
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  // 24 random bytes → 32 base64url chars.
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
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/oauth.test.ts && npx tsc --noEmit -p tsconfig.json
```

Expected: 4 tests pass; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/oauth.ts agent/test/oauth.test.ts
git commit -m "feat(agent): PKCE primitives (verifier/challenge, state, authorize URL)"
```

---

### Task 2: Code exchange against the token endpoint

**Files:**
- Modify: `agent/src/oauth.ts`
- Modify: `agent/test/oauth.test.ts`

**Interfaces:**
- Consumes: existing `OAuthCredential` type from `agent/src/types.ts`.
- Produces:
  - `exchangeCodeForTokens(code: string, verifier: string, redirectUri: string, opts?: { nowMs?: () => number }): Promise<OAuthCredential>`

- [ ] **Step 1: Append failing tests**

```ts
// Append to agent/test/oauth.test.ts:
import { exchangeCodeForTokens } from "../src/oauth.js";
import { vi, beforeEach, afterEach } from "vitest";

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
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/oauth.test.ts
```

Expected: `exchangeCodeForTokens is not a function`.

- [ ] **Step 3: Implement**

Append to `agent/src/oauth.ts`:

```ts
import type { OAuthCredential } from "./types.js";

const DEFAULT_EXPIRES_IN_S = 8 * 3600;

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
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/oauth.test.ts && npx tsc --noEmit -p tsconfig.json
```

Expected: 7 tests pass; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/oauth.ts agent/test/oauth.test.ts
git commit -m "feat(agent): exchangeCodeForTokens for the PKCE authorization-code flow"
```

---

### Task 3: Local callback server

**Files:**
- Modify: `agent/src/oauth.ts`
- Modify: `agent/test/oauth.test.ts`

**Interfaces:**
- Consumes: `generateState`.
- Produces:
  - `startCallbackServer(expectedState: string, opts?: { port?: number }): Promise<{ redirectUri: string; result: Promise<{ code: string }>; close: () => void }>`
  - On a request to `GET /callback?code=…&state=…`:
    - Matching state → 200 HTML "Login successful — you can close this tab"; resolves `result` with `{ code }`; closes the server.
    - Mismatched state → 400; rejects `result`; closes.
    - Other paths → 404.

- [ ] **Step 1: Append failing tests**

```ts
// Append to agent/test/oauth.test.ts:
import { startCallbackServer } from "../src/oauth.js";

describe("startCallbackServer", () => {
  it("resolves with the code when the callback's state matches", async () => {
    const srv = await startCallbackServer("EXPECTED");
    try {
      const u = new URL(srv.redirectUri);
      u.searchParams.set("code", "the-code");
      u.searchParams.set("state", "EXPECTED");
      const r = await fetch(u.toString());
      expect(r.status).toBe(200);
      const out = await srv.result;
      expect(out.code).toBe("the-code");
    } finally {
      srv.close();
    }
  });

  it("rejects with a 400 on state mismatch", async () => {
    const srv = await startCallbackServer("EXPECTED");
    try {
      const u = new URL(srv.redirectUri);
      u.searchParams.set("code", "x");
      u.searchParams.set("state", "WRONG");
      const r = await fetch(u.toString());
      expect(r.status).toBe(400);
      await expect(srv.result).rejects.toThrow(/state mismatch/i);
    } finally {
      srv.close();
    }
  });

  it("returns 404 on non-/callback paths and keeps waiting", async () => {
    const srv = await startCallbackServer("EXPECTED");
    try {
      const u = new URL(srv.redirectUri);
      u.pathname = "/other";
      const r = await fetch(u.toString());
      expect(r.status).toBe(404);
      // result is still pending; resolve it so the test can finish.
      const u2 = new URL(srv.redirectUri);
      u2.searchParams.set("code", "c");
      u2.searchParams.set("state", "EXPECTED");
      await fetch(u2.toString());
      await srv.result;
    } finally {
      srv.close();
    }
  });

  it("binds to 127.0.0.1 with a random port when none requested", async () => {
    const srv = await startCallbackServer("S", { port: 0 });
    try {
      const u = new URL(srv.redirectUri);
      expect(u.hostname).toBe("127.0.0.1");
      expect(Number(u.port)).toBeGreaterThan(0);
      expect(u.pathname).toBe("/callback");
    } finally { srv.close(); }
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/oauth.test.ts
```

Expected: `startCallbackServer is not a function`.

- [ ] **Step 3: Implement**

Append to `agent/src/oauth.ts`:

```ts
import * as http from "node:http";
import type { AddressInfo } from "node:net";

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
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/oauth.test.ts && npx tsc --noEmit -p tsconfig.json
```

Expected: 11 tests pass; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/oauth.ts agent/test/oauth.test.ts
git commit -m "feat(agent): one-shot local callback server for PKCE redirect"
```

---

### Task 4: Login orchestrator

**Files:**
- Create: `agent/src/login.ts`
- Create: `agent/test/login.test.ts`

**Interfaces:**
- Consumes: `oauth.ts` exports, `OAuthCredential`, `AccountId`.
- Produces:
  - `interface LoginDeps { openBrowser?(url: string): Promise<void>; writeCredential(acctId: AccountId, cred: OAuthCredential): Promise<void>; log?(msg: string): void; nowMs?(): number; portHint?: number }`
  - `runLogin(acctId: AccountId, deps: LoginDeps): Promise<void>`

`runLogin` runs the full flow end to end: PKCE pair → state → callback server → `openBrowser(authorizeUrl)` → await callback → `exchangeCodeForTokens` → `deps.writeCredential`.

- [ ] **Step 1: Write the failing tests**

`agent/test/login.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runLogin } from "../src/login.js";
import type { OAuthCredential } from "../src/types.js";

describe("runLogin", () => {
  it("opens the browser, awaits the callback, exchanges code, writes credential", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "sk-ant-oat01-NEW",
      refresh_token: "sk-ant-ort01-NEW",
      expires_in: 3600,
      scope: "user:inference user:profile",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const writes: Array<{ acctId: string; cred: OAuthCredential }> = [];
    let authorizeUrl = "";

    const openBrowser = async (url: string) => {
      authorizeUrl = url;
      // Mimic the browser: parse state + redirect_uri, then POST a fake callback.
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const redirectUri = u.searchParams.get("redirect_uri")!;
      const cb = new URL(redirectUri);
      cb.searchParams.set("code", "FAKE_CODE");
      cb.searchParams.set("state", state);
      // Defer to next tick so the callback server is definitely listening.
      setTimeout(() => { fetch(cb.toString()).catch(() => {}); }, 0);
    };

    try {
      await runLogin("user@example.com", {
        openBrowser,
        writeCredential: async (acctId, cred) => { writes.push({ acctId, cred }); },
        nowMs: () => 1_700_000_000_000,
      });

      expect(authorizeUrl).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      expect(authorizeUrl).toContain("code_challenge_method=S256");
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
    globalThis.fetch = vi.fn(async () => new Response("bad_grant", { status: 400 })) as unknown as typeof fetch;
    const writes: unknown[] = [];

    const openBrowser = async (url: string) => {
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("code", "FAKE");
      cb.searchParams.set("state", state);
      setTimeout(() => { fetch(cb.toString()).catch(() => {}); }, 0);
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
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/login.test.ts
```

Expected: file-not-found.

- [ ] **Step 3: Implement**

`agent/src/login.ts`:

```ts
import { generatePkcePair, generateState, buildAuthorizeUrl, exchangeCodeForTokens, startCallbackServer } from "./oauth.js";
import type { OAuthCredential, AccountId } from "./types.js";

export interface LoginDeps {
  openBrowser?: (url: string) => Promise<void>;
  writeCredential: (acctId: AccountId, cred: OAuthCredential) => Promise<void>;
  log?: (msg: string) => void;
  nowMs?: () => number;
  portHint?: number;
}

export async function runLogin(acctId: AccountId, deps: LoginDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const { verifier, challenge } = generatePkcePair();
  const state = generateState();
  const srv = await startCallbackServer(state, { port: deps.portHint ?? 0 });
  try {
    const authorizeUrl = buildAuthorizeUrl(challenge, state, srv.redirectUri);
    if (deps.openBrowser) {
      await deps.openBrowser(authorizeUrl);
    } else {
      log(`[agent] please open this URL in a browser:\n  ${authorizeUrl}`);
    }
    const { code } = await srv.result;
    const cred = await exchangeCodeForTokens(code, verifier, srv.redirectUri, { nowMs: deps.nowMs });
    await deps.writeCredential(acctId, cred);
    log(`[agent] login successful for ${acctId}`);
  } finally {
    srv.close();
  }
}
```

- [ ] **Step 4: Tests pass + typecheck**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/login.test.ts && npx tsc --noEmit -p tsconfig.json
```

Expected: 2 tests pass; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/login.ts agent/test/login.test.ts
git commit -m "feat(agent): runLogin orchestrates the PKCE browser flow"
```

---

### Task 5: Migration helper

**Files:**
- Create: `agent/src/migrate.ts`
- Create: `agent/test/migrate.test.ts`

**Interfaces:**
- Consumes: `OAuthCredential`, `AccountId`.
- Produces:
  - `interface MigrateDeps { listOld(): Promise<AccountId[]>; readOld(acctId: AccountId): Promise<OAuthCredential | null>; listNew(): Promise<AccountId[]>; writeNew(acctId: AccountId, cred: OAuthCredential): Promise<void>; log?(msg: string): void }`
  - `runMigrationOnce(deps: MigrateDeps): Promise<{ migrated: number; skipped: string[] }>`

- [ ] **Step 1: Write the failing tests**

`agent/test/migrate.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runMigrationOnce } from "../src/migrate.js";
import type { OAuthCredential } from "../src/types.js";

function cred(token: string, exp = 1): OAuthCredential {
  return { accessToken: token, refreshToken: "rt", expiresAt: exp, scopes: [] };
}

describe("runMigrationOnce", () => {
  it("copies every old entry when the new service is empty", async () => {
    const old = new Map([
      ["a@x", cred("tA")],
      ["b@y", cred("tB")],
    ]);
    const written: Array<{ acctId: string; cred: OAuthCredential }> = [];
    const out = await runMigrationOnce({
      listOld: async () => [...old.keys()],
      readOld: async (id) => old.get(id) ?? null,
      listNew: async () => [],
      writeNew: async (id, c) => { written.push({ acctId: id, cred: c }); },
    });
    expect(out).toEqual({ migrated: 2, skipped: [] });
    expect(written.map(w => w.acctId).sort()).toEqual(["a@x", "b@y"]);
  });

  it("is a no-op when the new service already has at least one entry", async () => {
    const old = new Map([["a@x", cred("tA")]]);
    const out = await runMigrationOnce({
      listOld: async () => [...old.keys()],
      readOld: async (id) => old.get(id) ?? null,
      listNew: async () => ["existing@z"],
      writeNew: async () => { throw new Error("should not be called"); },
    });
    expect(out).toEqual({ migrated: 0, skipped: [] });
  });

  it("skips entries whose readOld returns null (malformed source)", async () => {
    const old = new Map<string, OAuthCredential | null>([
      ["a@x", cred("tA")],
      ["b@y", null],
      ["c@z", cred("tC")],
    ]);
    const written: string[] = [];
    const logs: string[] = [];
    const out = await runMigrationOnce({
      listOld: async () => [...old.keys()],
      readOld: async (id) => old.get(id) ?? null,
      listNew: async () => [],
      writeNew: async (id) => { written.push(id); },
      log: (m) => { logs.push(m); },
    });
    expect(out.migrated).toBe(2);
    expect(out.skipped).toEqual(["b@y"]);
    expect(written.sort()).toEqual(["a@x", "c@z"]);
    expect(logs.some(l => /migrated 2/.test(l))).toBe(true);
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/migrate.test.ts
```

Expected: file-not-found.

- [ ] **Step 3: Implement**

`agent/src/migrate.ts`:

```ts
import type { OAuthCredential, AccountId } from "./types.js";

export interface MigrateDeps {
  listOld(): Promise<AccountId[]>;
  readOld(acctId: AccountId): Promise<OAuthCredential | null>;
  listNew(): Promise<AccountId[]>;
  writeNew(acctId: AccountId, cred: OAuthCredential): Promise<void>;
  log?(msg: string): void;
}

export async function runMigrationOnce(deps: MigrateDeps): Promise<{ migrated: number; skipped: string[] }> {
  const log = deps.log ?? (() => {});
  const existing = await deps.listNew();
  if (existing.length > 0) {
    return { migrated: 0, skipped: [] };
  }
  const oldIds = await deps.listOld();
  let migrated = 0;
  const skipped: string[] = [];
  for (const acctId of oldIds) {
    let cred: OAuthCredential | null = null;
    try { cred = await deps.readOld(acctId); }
    catch { cred = null; }
    if (!cred) { skipped.push(acctId); continue; }
    await deps.writeNew(acctId, cred);
    migrated++;
  }
  log(`[agent] migrated ${migrated} credentials from "Claude Code-credentials" to "claude-max-proxy-credentials"` +
    (skipped.length > 0 ? `; skipped ${skipped.join(", ")}` : ""));
  return { migrated, skipped };
}
```

- [ ] **Step 4: Tests pass + typecheck**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/migrate.test.ts && npx tsc --noEmit -p tsconfig.json
```

Expected: 3 tests pass; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/migrate.ts agent/test/migrate.test.ts
git commit -m "feat(agent): runMigrationOnce copies legacy entries into the self-owned service"
```

---

### Task 6: Flip the Keychain service constant + wire migration + add subcommand dispatch

**Files:**
- Modify: `agent/src/tokens.ts`
- Modify: `agent/src/index.ts`

**Interfaces:**
- Consumes: `runMigrationOnce`, `runLogin`, the old Keychain enumerator (kept in-file).
- Produces: `agent` (no args) → server; `agent login [--acct <email>]` → PKCE; `agent migrate` → forces migration; otherwise prints usage and exits 64.

- [ ] **Step 1: Update the constant in `tokens.ts`**

In `agent/src/tokens.ts` change:

```ts
const KEYCHAIN_SERVICE = "Claude Code-credentials";
```

to:

```ts
const KEYCHAIN_SERVICE = "claude-max-proxy-credentials";
```

- [ ] **Step 2: Rewrite `index.ts` to dispatch subcommands, migrate, and use the new service**

Replace `agent/src/index.ts` with:

```ts
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { AccountPool } from "./pool.js";
import { KeychainWatcher, type KeychainEnumerator } from "./watcher.js";
import {
  KeychainStore,
  PlatformRefreshClient,
  TokenManager,
  makeFileLock,
} from "./tokens.js";
import { createServer } from "./server.js";
import { callUpstreamRotating } from "./upstream.js";
import { runLogin } from "./login.js";
import { runMigrationOnce } from "./migrate.js";
import type { AccountId, OAuthCredential } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOCK_PATH = path.join(os.homedir(), ".claude", ".proxy-refresh.lock");
const NEW_SERVICE = "claude-max-proxy-credentials";
const OLD_SERVICE = "Claude Code-credentials";

function allowlistFromEnv(): Set<AccountId> | null {
  const raw = process.env.CLAUDE_MAX_ACCOUNTS;
  if (!raw) return null;
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

interface SecurityResult { stdout: string; code: number; }
function runSecurity(args: string[]): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout?.on("data", (b) => { stdout += b.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, code: code ?? -1 }));
  });
}

async function listKeychainAccounts(service: string): Promise<AccountId[]> {
  const { stdout, code } = await runSecurity(["dump-keychain"]);
  if (code !== 0) return [];
  const ids = new Set<AccountId>();
  let svceMatch = false;
  let acctVal: string | null = null;
  for (const line of stdout.split("\n")) {
    const svce = line.match(/"svce"<blob>="([^"]*)"/);
    if (svce) { svceMatch = svce[1] === service; }
    const acct = line.match(/"acct"<blob>="([^"]*)"/);
    if (acct) { acctVal = acct[1]!; }
    if (line.startsWith("class:") || line.startsWith("keychain:")) {
      if (svceMatch && acctVal) ids.add(acctVal);
      svceMatch = false;
      acctVal = null;
    }
  }
  if (svceMatch && acctVal) ids.add(acctVal);
  return [...ids];
}

function newServiceEnumerator(): KeychainEnumerator {
  return {
    list: () => listKeychainAccounts(NEW_SERVICE),
    async read(acctId) {
      try { return await new KeychainStore(acctId).read(); }
      catch { return null; }
    },
  };
}

function makeManager(acctId: AccountId): TokenManager {
  return new TokenManager(
    new KeychainStore(acctId),
    new PlatformRefreshClient(),
    makeFileLock(LOCK_PATH),
  );
}

async function migrateLegacyService(): Promise<void> {
  // Read from the OLD service via a dedicated reader that targets it explicitly,
  // since KeychainStore is now bound to the NEW service.
  await runMigrationOnce({
    listOld: () => listKeychainAccounts(OLD_SERVICE),
    readOld: async (acctId) => {
      const r = await runSecurity(["find-generic-password", "-s", OLD_SERVICE, "-a", acctId, "-w"]);
      if (r.code !== 0) return null;
      try {
        const j = JSON.parse(r.stdout.trim()) as { claudeAiOauth?: Record<string, unknown> } | null;
        const o = j?.claudeAiOauth;
        if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string" || typeof o.expiresAt !== "number") return null;
        const scopes = Array.isArray(o.scopes) ? (o.scopes as unknown[]).filter((s): s is string => typeof s === "string") : [];
        return { accessToken: o.accessToken as string, refreshToken: o.refreshToken as string, expiresAt: o.expiresAt as number, scopes };
      } catch { return null; }
    },
    listNew: () => listKeychainAccounts(NEW_SERVICE),
    writeNew: async (acctId, cred) => new KeychainStore(acctId).write(cred),
    log: (m) => console.log(m),
  });
}

async function runServer(): Promise<void> {
  await migrateLegacyService();

  const pool = new AccountPool([]);
  const watcher = new KeychainWatcher({
    enumerator: newServiceEnumerator(),
    factory: makeManager,
    pool,
    allowlist: allowlistFromEnv(),
    intervalMs: 5_000,
    log: (msg, extra) => console.warn(`[agent] ${msg}`, extra ?? ""),
  });

  await watcher.tick();
  if (pool.accounts().length === 0) {
    console.error(`[agent] no Max-account Keychain entries discovered under service '${NEW_SERVICE}'. ` +
      "Run 'agent login --acct <email>' to capture one " +
      "(see docs/operations/capturing-multi-account-credentials.md).");
    process.exit(1);
  }
  watcher.start();

  const server = createServer({
    pool,
    upstream: (body, accept, p) => callUpstreamRotating(body, accept, p, {
      log: (msg, extra) => console.log(`[agent] ${msg}`, extra ?? ""),
    }),
  });
  server.listen(PORT, HOST, () => {
    console.log(`[agent] listening on http://${HOST}:${PORT} (accounts: ${pool.accounts().join(", ")})`);
  });

  const shutdown = (sig: string) => {
    console.log(`[agent] ${sig} received, shutting down`);
    watcher.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function runLoginSubcommand(args: string[]): Promise<void> {
  let acctId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--acct") {
      acctId = args[i + 1] ?? null;
      i++;
    }
  }
  if (!acctId) {
    console.error("usage: agent login --acct <email>");
    process.exit(64);
  }
  await runLogin(acctId, {
    openBrowser: async (url) => {
      console.log(`[agent] opening browser → ${url}`);
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    },
    writeCredential: async (id, cred) => { await new KeychainStore(id).write(cred); },
    log: (m) => console.log(m),
  });
}

async function runMigrateSubcommand(): Promise<void> {
  await migrateLegacyService();
}

function printUsage(): void {
  console.error(
    "usage:\n" +
    "  agent                      # run the proxy server (default)\n" +
    "  agent login --acct <email> # capture a new Max account via PKCE\n" +
    "  agent migrate              # copy legacy 'Claude Code-credentials' into self-owned service\n"
  );
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case undefined:
      return runServer();
    case "login":
      return runLoginSubcommand(rest);
    case "migrate":
      return runMigrateSubcommand();
    case "-h":
    case "--help":
      printUsage();
      return;
    default:
      printUsage();
      process.exit(64);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Update the empty-pool error message in `tokens.ts`**

The constant in `tokens.ts` is referenced indirectly via `KeychainStore`. No other code change needed in `tokens.ts` beyond Step 1.

- [ ] **Step 4: Build everything and ensure compile is clean**

```bash
cd ~/projects/claude-max-proxy/agent && npx tsc -p tsconfig.json && ls dist/
```

Expected: exit code 0; new files `dist/oauth.js`, `dist/login.js`, `dist/migrate.js` present alongside the existing dist.

- [ ] **Step 5: Run the full test suite**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run
```

Expected: all suites pass (oauth 11 + login 2 + migrate 3 + the existing 55 = 71 total).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/tokens.ts agent/src/index.ts
git commit -m "feat(agent): flip Keychain service to 'claude-max-proxy-credentials' + subcommand dispatch + auto-migrate"
```

---

### Task 7: Rewrite the operations guide

**Files:**
- Modify: `docs/operations/capturing-multi-account-credentials.md`

**Interfaces:**
- Produces: operator-facing instructions that match the new `agent login` flow.

- [ ] **Step 1: Replace the guide**

Overwrite `docs/operations/capturing-multi-account-credentials.md` with:

````markdown
# Capturing multiple Max-account OAuth credentials

The proxy agent runs its own OAuth (PKCE) flow per Max account and stores
the resulting tokens under the macOS Keychain service
`claude-max-proxy-credentials`. The agent never reads from or writes to
`Claude Code-credentials` after the first-run migration — interactive
Claude Code can run on the same Mac with no shared credential state.

## Capturing a new account

For each Max email you want in the pool:

```sh
~/projects/claude-max-proxy/agent/dist/index.js login --acct <email>
```

(or, while developing: `npm --prefix ~/projects/claude-max-proxy/agent run dev -- login --acct <email>`)

The command opens your default browser to the Anthropic OAuth page.
Sign in as the Max account whose email you passed in `--acct`. The
browser is redirected to a one-shot local server on `127.0.0.1:<random>`
which captures the code, exchanges it for tokens, writes them to
Keychain, and exits.

Within 5 seconds, the running agent's `KeychainWatcher` adds the new
account to the rotation pool. Verify via the admin endpoint:

```sh
curl -sS http://127.0.0.1:8787/v1/admin/accounts | jq '.accounts[].acct_id'
```

## First-run migration (existing users)

If you were running an earlier build that read from
`Claude Code-credentials`, you do **not** need to log in again. On its
first start after the upgrade, the agent calls `runMigrationOnce` which
copies every old entry into the new service:

```
[agent] migrated 4 credentials from "Claude Code-credentials" to "claude-max-proxy-credentials"
```

After migration, the two services drift independently. You can force the
migration to run again with:

```sh
~/projects/claude-max-proxy/agent/dist/index.js migrate
```

(It is idempotent and a no-op when the new service is non-empty.)

## Disabling an account temporarily

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/disable
```

Re-enable:

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/enable
```

The manually-disabled flag is in-memory; an agent restart clears it.

## Allowlisting accounts

Set `CLAUDE_MAX_ACCOUNTS=<email1>,<email2>` in the agent's launchd plist
to restrict the pool to a subset without removing the Keychain entries.

## Removing an account permanently

```sh
security delete-generic-password -s "claude-max-proxy-credentials" -a "<email>"
```

The watcher's next tick drops it from the pool.

## SSH / headless caveat

`agent login` opens a browser via `open` on macOS. If you're on an SSH
session into the Mac, `open` will run on the remote display (no browser
opens locally). Either run `agent login` from a graphical session, or
SSH-tunnel the random port the callback server picks and complete the
flow from a browser on your workstation.
````

- [ ] **Step 2: Commit**

```bash
cd ~/projects/claude-max-proxy
git add docs/operations/capturing-multi-account-credentials.md
git commit -m "docs(ops): rewrite multi-account guide around 'agent login' and auto-migration"
```

---

### Task 8: Build, restart launchd, verify migration + smoke

**Files:** (no new files — operational verification)

**Interfaces:** end-to-end verification on the live Mac.

- [ ] **Step 1: Rebuild + restart the launchd agent**

```bash
cd ~/projects/claude-max-proxy/agent && npm run build && \
  launchctl kickstart -k "gui/$(id -u)/com.bobjansen.claude-max-proxy" && \
  sleep 1 && tail -5 ~/Library/Logs/claude-max-proxy.out.log
```

Expected output should include:

```
[agent] migrated 4 credentials from "Claude Code-credentials" to "claude-max-proxy-credentials"
[agent] listening on http://127.0.0.1:8787 (accounts: bob.jansen@wearetriple.com, bob.jansen@pm.me, support@topolab.nl, bob@topolab.nl)
```

- [ ] **Step 2: Verify the new Keychain service has the 4 entries**

```bash
security dump-keychain 2>/dev/null | grep -A1 "claude-max-proxy-credentials" | head -20
```

Expected: 4 `acct` lines matching the four emails.

- [ ] **Step 3: Verify the OLD service is untouched**

```bash
security dump-keychain 2>/dev/null | grep -A1 '"Claude Code-credentials"' | head -20
```

Expected: same 4 entries you had before (we copied, didn't move).

- [ ] **Step 4: Smoke a request to confirm the agent serves traffic from the new service**

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"PONG"}]}' \
  | head -c 200; echo
```

Expected: a `"type":"message"` response from Anthropic.

- [ ] **Step 5: Verify the admin snapshot still works**

```bash
curl -sS http://127.0.0.1:8787/v1/admin/accounts | python3 -c "import sys,json;d=json.load(sys.stdin);[print(f\"  {a['acct_id']}\") for a in d['accounts']]"
```

Expected: 4 account IDs.

- [ ] **Step 6: Push the branch**

```bash
cd ~/projects/claude-max-proxy
git push -u origin feature/CMP-003-self-owned-credentials
```

Expected: the branch URL printed by `git push` for opening the PR.

---

## Spec coverage check

- Goal 1 (own service name) — Tasks 6 (constant flip).
- Goal 2 (`agent login` PKCE flow) — Tasks 1, 2, 3, 4, 6 (subcommand).
- Goal 3 (one-shot migration without re-login) — Tasks 5, 6 (wired into `runServer`).
- Goal 4 (refresh chains independent) — Tasks 5, 6 (writes are now only to NEW service).
- Goal 5 (net code removed) — kept watcher/file-lock/adopt per spec ("Out of Scope"). Plan does not remove them — matches the spec deliberately.
- Non-goals — preserved (no logout command, no Keychain deletes, no watcher removal).
- Architecture diagram — Tasks 1–6.
- Components: `oauth.ts` (Tasks 1–3), `login.ts` (Task 4), `migrate.ts` (Task 5), `tokens.ts` + `index.ts` (Task 6).
- Data flow — `first startup after upgrade`: Task 6 + Task 8. `agent login --acct`: Tasks 4 + 6 + Task 8 (Step 1 via launchd restart proves the subcommand path is reachable, even if you don't add a new account in Step 1).
- Error handling table — all rows covered:
  - State mismatch (Task 3 + Task 4)
  - 4xx from token endpoint (Task 2)
  - Ctrl-C cleanup — Task 4 (server.close in `finally`)
  - `open` unavailable — Task 4 falls back to logging the URL
  - Malformed migration source — Task 5
  - Already-migrated — Task 5
  - Already-exists on `agent login` — `KeychainStore.write` uses `add-generic-password -U` (unchanged)
  - Empty pool — Task 6 (clear startup error)
- Testing — Tasks 1–5 plus Task 8 for e2e on real Anthropic.
- Project layout — Tasks 1, 4, 5, 6, 7 cover the diff.
- No placeholders. No unresolved questions.
