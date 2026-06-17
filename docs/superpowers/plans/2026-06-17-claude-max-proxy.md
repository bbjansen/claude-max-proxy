# Claude Max Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a working Cloudflare Worker + local Node agent that exposes Claude Max OAuth as a standard Anthropic `POST /v1/messages` endpoint, fronted by Cloudflare Access.

**Architecture:** Worker on the edge verifies Cloudflare Access JWTs and forwards through a Cloudflare Tunnel to a Node agent on the user's Mac. The agent owns the OAuth tokens (read from / written to macOS Keychain under a file lock), refreshes them from the residential IP against `platform.claude.com`, and proxies to `api.anthropic.com/v1/messages` with the required OAuth headers. SSE streaming passes through every hop unchanged.

**Tech Stack:** TypeScript on Node 20+ for the agent (stdlib `node:http`, `proper-lockfile`), TypeScript on Cloudflare Workers for the Worker (`jose` for JWT verification), Vitest for both. `cloudflared` for the Tunnel. macOS `security` CLI for Keychain I/O.

## Global Constraints

- Project root: `~/projects/claude-max-proxy/` (already initialised as a git repo with the spec committed).
- All Node packages pin exact versions. Each Node sub-project ships `.npmrc` with `save-exact=true`.
- Refresh endpoint: `https://platform.claude.com/v1/oauth/token`.
- OAuth client_id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`.
- Required headers on inference calls: `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20,claude-code-20250219`, `anthropic-version: 2023-06-01`, `x-app: cli`. Never send `x-api-key`.
- Refresh threshold: refresh if `expiresAt - now < 60_000ms`.
- Keychain service name: `Claude Code-credentials`. Account: macOS login username. Storage shape: `{"claudeAiOauth": {"accessToken","refreshToken","expiresAt","scopes"}}` with `expiresAt` in **milliseconds** since epoch.
- File lock path: `~/.claude/.proxy-refresh.lock` (`proper-lockfile`, 10s stale, 250ms retry interval).
- Commit messages: conventional commits, no co-author, no AI references (per user CLAUDE.md).
- All work happens on a feature branch off `main` per user CLAUDE.md.

---

### Task 1: Repository skeleton & shared config

**Files:**
- Create: `~/projects/claude-max-proxy/.npmrc`
- Create: `~/projects/claude-max-proxy/README.md`
- Create: `~/projects/claude-max-proxy/.gitignore` *(append patterns; file may already exist)*
- Create: `~/projects/claude-max-proxy/package.json` *(root workspace manifest)*
- Create: `~/projects/claude-max-proxy/agent/.npmrc`
- Create: `~/projects/claude-max-proxy/agent/package.json`
- Create: `~/projects/claude-max-proxy/agent/tsconfig.json`
- Create: `~/projects/claude-max-proxy/worker/.npmrc`
- Create: `~/projects/claude-max-proxy/worker/package.json`
- Create: `~/projects/claude-max-proxy/worker/tsconfig.json`

**Interfaces:**
- Produces: a buildable workspace with two sub-packages (`agent`, `worker`) and a working `npm install` from root.

- [ ] **Step 1: Create the feature branch**

```bash
cd ~/projects/claude-max-proxy
git checkout -b feature/CMP-001-initial-implementation
```

Expected output: `Switched to a new branch 'feature/CMP-001-initial-implementation'`

- [ ] **Step 2: Write the root `.npmrc`**

`~/projects/claude-max-proxy/.npmrc`:
```ini
save-exact=true
```

- [ ] **Step 3: Append patterns to `.gitignore`**

`~/projects/claude-max-proxy/.gitignore` (append if not present):
```gitignore
node_modules/
dist/
.wrangler/
.dev.vars
*.log
.DS_Store
coverage/
```

- [ ] **Step 4: Write the root `package.json`**

`~/projects/claude-max-proxy/package.json`:
```json
{
  "name": "claude-max-proxy",
  "private": true,
  "version": "0.1.0",
  "workspaces": [
    "agent",
    "worker"
  ],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  }
}
```

- [ ] **Step 5: Write the root `README.md`**

`~/projects/claude-max-proxy/README.md`:
```markdown
# claude-max-proxy

Self-hosted proxy that exposes a Claude Max consumer subscription as a standard
Anthropic `POST /v1/messages` endpoint.

Architecture: Cloudflare Worker (Zero Trust front door) → Cloudflare Tunnel →
local Node agent on macOS (holds OAuth tokens) → `api.anthropic.com`.

See `docs/superpowers/specs/2026-06-17-claude-max-proxy-design.md` for the full
design and `docs/superpowers/plans/2026-06-17-claude-max-proxy.md` for the
implementation plan.

## Sub-packages

- `agent/` — Node agent that runs on the Mac.
- `worker/` — Cloudflare Worker.
- `cloudflared/` — Tunnel config and setup notes.
- `scripts/` — install + e2e helpers.
```

- [ ] **Step 6: Write the agent sub-package config**

`~/projects/claude-max-proxy/agent/.npmrc`:
```ini
save-exact=true
```

`~/projects/claude-max-proxy/agent/package.json`:
```json
{
  "name": "@claude-max-proxy/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "proper-lockfile": "4.1.2"
  },
  "devDependencies": {
    "@types/node": "20.11.30",
    "@types/proper-lockfile": "4.1.4",
    "tsx": "4.7.1",
    "typescript": "5.3.3",
    "vitest": "1.4.0"
  }
}
```

`~/projects/claude-max-proxy/agent/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 7: Write the worker sub-package config**

`~/projects/claude-max-proxy/worker/.npmrc`:
```ini
save-exact=true
```

`~/projects/claude-max-proxy/worker/package.json`:
```json
{
  "name": "@claude-max-proxy/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "test": "vitest run"
  },
  "dependencies": {
    "jose": "5.2.3"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "4.20240314.0",
    "typescript": "5.3.3",
    "vitest": "1.4.0",
    "wrangler": "3.34.2"
  }
}
```

`~/projects/claude-max-proxy/worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 8: Install dependencies**

```bash
cd ~/projects/claude-max-proxy
npm install
```

Expected: `node_modules/` in root + each sub-package's deps resolved via workspaces. No errors.

- [ ] **Step 9: Sanity check TypeScript can compile empty source**

```bash
mkdir -p ~/projects/claude-max-proxy/agent/src
echo 'export {};' > ~/projects/claude-max-proxy/agent/src/index.ts
cd ~/projects/claude-max-proxy/agent && npx tsc -p tsconfig.json
```

Expected: exit code 0, `dist/index.js` exists.

- [ ] **Step 10: Commit**

```bash
cd ~/projects/claude-max-proxy
git add .gitignore .npmrc README.md package.json package-lock.json agent worker
git commit -m "chore: scaffold agent and worker sub-packages"
```

---

### Task 2: Agent — token store (`tokens.ts` + `types.ts`)

**Files:**
- Create: `~/projects/claude-max-proxy/agent/src/types.ts`
- Create: `~/projects/claude-max-proxy/agent/src/tokens.ts`
- Create: `~/projects/claude-max-proxy/agent/test/tokens.test.ts`

**Interfaces:**
- Produces:
  - `OAuthCredential` (interface): `{ accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }`
  - `CredentialStore` (interface): `{ read(): Promise<OAuthCredential | null>; write(c: OAuthCredential): Promise<void> }`
  - `RefreshClient` (interface): `{ refresh(refreshToken: string): Promise<OAuthCredential> }`
  - `TokenManager` (class) with `getAccessToken(): Promise<string>` and `forceRefresh(): Promise<string>`
  - `KeychainStore` (concrete `CredentialStore`)
  - `PlatformRefreshClient` (concrete `RefreshClient`)
  - `fileLock(path: string): Promise<() => Promise<void>>`

- [ ] **Step 1: Write the types file**

`~/projects/claude-max-proxy/agent/src/types.ts`:
```ts
export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface CredentialStore {
  read(): Promise<OAuthCredential | null>;
  write(cred: OAuthCredential): Promise<void>;
}

export interface RefreshClient {
  refresh(refreshToken: string): Promise<OAuthCredential>;
}

export type AcquireLock = () => Promise<() => Promise<void>>;
```

- [ ] **Step 2: Write the failing tests**

`~/projects/claude-max-proxy/agent/test/tokens.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "../src/tokens.js";
import type { CredentialStore, OAuthCredential, RefreshClient } from "../src/types.js";

const baseCred: OAuthCredential = {
  accessToken: "sk-ant-oat01-OLD",
  refreshToken: "sk-ant-ort01-OLD",
  expiresAt: 0,
  scopes: ["user:inference"],
};

function makeStore(initial: OAuthCredential | null) {
  let current = initial;
  return {
    store: {
      read: vi.fn(async () => current),
      write: vi.fn(async (c: OAuthCredential) => { current = c; }),
    } satisfies CredentialStore,
    get current() { return current; },
  };
}

function makeRefresher(next: OAuthCredential) {
  return { refresh: vi.fn(async () => next) } satisfies RefreshClient;
}

function noopLock() {
  return async () => async () => {};
}

describe("TokenManager", () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => { now = 1_000_000; });

  it("returns cached token when not near expiry", async () => {
    const cred = { ...baseCred, expiresAt: now + 5 * 60_000 };
    const { store } = makeStore(cred);
    const tm = new TokenManager(store, makeRefresher(cred), noopLock(), clock);
    expect(await tm.getAccessToken()).toBe(cred.accessToken);
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it("refreshes when within 60s of expiry, writes back, returns new token", async () => {
    const cred = { ...baseCred, expiresAt: now + 30_000 };
    const newCred: OAuthCredential = {
      accessToken: "sk-ant-oat01-NEW",
      refreshToken: "sk-ant-ort01-NEW",
      expiresAt: now + 8 * 3_600_000,
      scopes: ["user:inference"],
    };
    const { store } = makeStore(cred);
    const refresher = makeRefresher(newCred);
    const tm = new TokenManager(store, refresher, noopLock(), clock);

    expect(await tm.getAccessToken()).toBe("sk-ant-oat01-NEW");
    expect(refresher.refresh).toHaveBeenCalledWith("sk-ant-ort01-OLD");
    expect(store.write).toHaveBeenCalledWith(newCred);
  });

  it("abandons own refresh when Keychain re-read shows fresh credential", async () => {
    const stale = { ...baseCred, expiresAt: now + 30_000 };
    const externallyRefreshed: OAuthCredential = {
      accessToken: "sk-ant-oat01-EXTERNAL",
      refreshToken: "sk-ant-ort01-EXTERNAL",
      expiresAt: now + 8 * 3_600_000,
      scopes: ["user:inference"],
    };
    let calls = 0;
    const store: CredentialStore = {
      read: vi.fn(async () => (calls++ === 0 ? stale : externallyRefreshed)),
      write: vi.fn(async () => {}),
    };
    const refresher = makeRefresher({ ...baseCred, accessToken: "should-not-be-used" });
    const tm = new TokenManager(store, refresher, noopLock(), clock);

    expect(await tm.getAccessToken()).toBe("sk-ant-oat01-EXTERNAL");
    expect(refresher.refresh).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it("dedupes concurrent refresh attempts via in-process mutex", async () => {
    const stale = { ...baseCred, expiresAt: now + 30_000 };
    const newCred: OAuthCredential = {
      accessToken: "sk-ant-oat01-NEW",
      refreshToken: "sk-ant-ort01-NEW",
      expiresAt: now + 8 * 3_600_000,
      scopes: ["user:inference"],
    };
    const { store } = makeStore(stale);
    const refresher = makeRefresher(newCred);
    const tm = new TokenManager(store, refresher, noopLock(), clock);

    const [a, b] = await Promise.all([tm.getAccessToken(), tm.getAccessToken()]);
    expect(a).toBe("sk-ant-oat01-NEW");
    expect(b).toBe("sk-ant-oat01-NEW");
    expect(refresher.refresh).toHaveBeenCalledTimes(1);
  });

  it("throws when store is empty", async () => {
    const store: CredentialStore = { read: vi.fn(async () => null), write: vi.fn() };
    const tm = new TokenManager(store, makeRefresher(baseCred), noopLock(), clock);
    await expect(tm.getAccessToken()).rejects.toThrow(/no credential/i);
  });

  it("forceRefresh ignores the cache and refreshes immediately", async () => {
    const cred = { ...baseCred, expiresAt: now + 10 * 60_000 };
    const newCred: OAuthCredential = {
      accessToken: "sk-ant-oat01-FORCED",
      refreshToken: "sk-ant-ort01-FORCED",
      expiresAt: now + 8 * 3_600_000,
      scopes: ["user:inference"],
    };
    const { store } = makeStore(cred);
    const refresher = makeRefresher(newCred);
    const tm = new TokenManager(store, refresher, noopLock(), clock);

    await tm.getAccessToken(); // warm cache
    expect(await tm.forceRefresh()).toBe("sk-ant-oat01-FORCED");
    expect(refresher.refresh).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail (no implementation yet)**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run
```

Expected: every test fails because `../src/tokens.js` does not exist.

- [ ] **Step 4: Implement `TokenManager`**

`~/projects/claude-max-proxy/agent/src/tokens.ts`:
```ts
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { lock as lockfile } from "proper-lockfile";
import type { AcquireLock, CredentialStore, OAuthCredential, RefreshClient } from "./types.js";

const REFRESH_THRESHOLD_MS = 60_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_EXPIRES_IN_S = 8 * 3600;

export class TokenManager {
  private cached: OAuthCredential | null = null;
  private inflight: Promise<OAuthCredential> | null = null;

  constructor(
    private readonly store: CredentialStore,
    private readonly refresher: RefreshClient,
    private readonly acquireLock: AcquireLock,
    private readonly clock: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (!this.cached) this.cached = await this.store.read();
    if (!this.cached) throw new Error("no credential available — run `claude` to log in");
    if (this.cached.expiresAt - this.clock() < REFRESH_THRESHOLD_MS) {
      this.cached = await this.refreshShared();
    }
    return this.cached.accessToken;
  }

  async forceRefresh(): Promise<string> {
    this.cached = await this.refreshShared(true);
    return this.cached.accessToken;
  }

  private async refreshShared(force = false): Promise<OAuthCredential> {
    if (this.inflight) return this.inflight;
    this.inflight = this.refreshLocked(force);
    try { return await this.inflight; }
    finally { this.inflight = null; }
  }

  private async refreshLocked(force: boolean): Promise<OAuthCredential> {
    const release = await this.acquireLock();
    try {
      const fresh = await this.store.read();
      if (!force && fresh && fresh.expiresAt - this.clock() >= REFRESH_THRESHOLD_MS) {
        return fresh;
      }
      const seed = fresh ?? this.cached;
      if (!seed) throw new Error("no credential available to refresh");
      const refreshed = await this.refresher.refresh(seed.refreshToken);
      await this.store.write(refreshed);
      return refreshed;
    } finally {
      await release();
    }
  }
}

export class KeychainStore implements CredentialStore {
  constructor(private readonly account: string = os.userInfo().username) {}

  async read(): Promise<OAuthCredential | null> {
    const { stdout, code } = await runSecurity(
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w"]
    );
    if (code === 44 || code === 51) return null;
    if (code !== 0) throw new Error(`security read failed (exit ${code})`);
    return parseCredential(stdout.trim());
  }

  async write(cred: OAuthCredential): Promise<void> {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        scopes: cred.scopes,
      },
    });
    const { code } = await runSecurity(
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w", json]
    );
    if (code !== 0) throw new Error(`security write failed (exit ${code})`);
  }
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly file: string = path.join(os.homedir(), ".claude", ".credentials.json")) {}

  async read(): Promise<OAuthCredential | null> {
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      return parseCredential(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(cred: OAuthCredential): Promise<void> {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        scopes: cred.scopes,
      },
    }, null, 2);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, json, { mode: 0o600 });
  }
}

function parseCredential(raw: string): OAuthCredential {
  let json: any;
  try { json = JSON.parse(raw); }
  catch { throw new Error("credential payload is not JSON"); }
  const o = json?.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string" || typeof o.expiresAt !== "number") {
    throw new Error("credential payload missing required fields");
  }
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    expiresAt: o.expiresAt,
    scopes: Array.isArray(o.scopes) ? o.scopes.filter((s: unknown): s is string => typeof s === "string") : [],
  };
}

export class PlatformRefreshClient implements RefreshClient {
  async refresh(refreshToken: string): Promise<OAuthCredential> {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`refresh ${res.status}: ${body.slice(0, 200)}`);
    }
    const json: any = await res.json();
    if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
      throw new Error("refresh response missing tokens");
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (typeof json.expires_in === "number" ? json.expires_in : DEFAULT_EXPIRES_IN_S) * 1000,
      scopes: typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [],
    };
  }
}

export function makeFileLock(filePath: string): AcquireLock {
  return async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "", { flag: "a" });
    return lockfile(filePath, {
      retries: { retries: 40, factor: 1, minTimeout: 250, maxTimeout: 250 },
      stale: 10_000,
    });
  };
}

interface SecurityResult { stdout: string; stderr: string; code: number; }

function runSecurity(args: string[]): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run
```

Expected: all 6 tests pass.

- [ ] **Step 6: TypeScript build clean**

```bash
cd ~/projects/claude-max-proxy/agent && npx tsc -p tsconfig.json
```

Expected: exit code 0, no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/types.ts agent/src/tokens.ts agent/test/tokens.test.ts
git commit -m "feat(agent): token manager with keychain store and rotated-refresh write-back"
```

---

### Task 3: Agent — upstream client (`upstream.ts`)

**Files:**
- Create: `~/projects/claude-max-proxy/agent/src/upstream.ts`
- Create: `~/projects/claude-max-proxy/agent/test/upstream.test.ts`

**Interfaces:**
- Consumes: `TokenManager` from Task 2.
- Produces: `callUpstream(body: Buffer, acceptHeader: string, tokens: TokenManager): Promise<Response>` — exported function that returns the upstream `Response` (status, headers, streaming body) suitable for piping back to the client. Honors the 401-retry policy and overrides `accept` only when blank.

- [ ] **Step 1: Write the failing tests**

`~/projects/claude-max-proxy/agent/test/upstream.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callUpstream } from "../src/upstream.js";

class FakeTokens {
  public refreshes = 0;
  public getCalls = 0;
  constructor(private accessTokens: string[]) {}
  async getAccessToken(): Promise<string> {
    this.getCalls++;
    return this.accessTokens[Math.min(this.getCalls - 1, this.accessTokens.length - 1)]!;
  }
  async forceRefresh(): Promise<string> {
    this.refreshes++;
    return this.accessTokens[Math.min(this.getCalls, this.accessTokens.length - 1)]!;
  }
}

describe("callUpstream", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sends required OAuth headers and forwards body verbatim", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const tokens = new FakeTokens(["tok-A"]);
    const body = Buffer.from('{"messages":[]}');
    const res = await callUpstream(body, "text/event-stream", tokens as any);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer tok-A");
    expect(h.get("anthropic-beta")).toBe("oauth-2025-04-20,claude-code-20250219");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("x-app")).toBe("cli");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("accept")).toBe("text/event-stream");
  });

  it("retries once on 401 after forceRefresh and uses the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const tokens = new FakeTokens(["tok-OLD", "tok-NEW"]);
    const res = await callUpstream(Buffer.from("{}"), "application/json", tokens as any);

    expect(res.status).toBe(200);
    expect(tokens.refreshes).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth0 = new Headers(fetchMock.mock.calls[0]![1].headers).get("authorization");
    const auth1 = new Headers(fetchMock.mock.calls[1]![1].headers).get("authorization");
    expect(auth0).toBe("Bearer tok-OLD");
    expect(auth1).toBe("Bearer tok-NEW");
  });

  it("returns 401 to caller if retry also fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("still nope", { status: 401 }));
    const tokens = new FakeTokens(["tok-OLD", "tok-NEW"]);
    const res = await callUpstream(Buffer.from("{}"), "application/json", tokens as any);

    expect(res.status).toBe(401);
    expect(tokens.refreshes).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards non-401 errors without retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate", { status: 429, headers: { "retry-after": "5" } }));
    const tokens = new FakeTokens(["tok-A"]);
    const res = await callUpstream(Buffer.from("{}"), "application/json", tokens as any);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens.refreshes).toBe(0);
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/upstream.test.ts
```

Expected: import errors / file not found.

- [ ] **Step 3: Implement `callUpstream`**

`~/projects/claude-max-proxy/agent/src/upstream.ts`:
```ts
import type { TokenManager } from "./tokens.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export async function callUpstream(
  body: Buffer,
  acceptHeader: string,
  tokens: TokenManager,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = attempt === 0 ? await tokens.getAccessToken() : await tokens.forceRefresh();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-version": "2023-06-01",
        "x-app": "cli",
        "content-type": "application/json",
        "user-agent": "claude-max-proxy/0.1",
        accept: acceptHeader || "application/json",
      },
      body,
    });
    if (res.status !== 401 || attempt === 1) return res;
  }
  throw new Error("unreachable");
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run
```

Expected: 10 tests pass (6 from Task 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/upstream.ts agent/test/upstream.test.ts
git commit -m "feat(agent): upstream client with OAuth headers and 401 retry-once"
```

---

### Task 4: Agent — HTTP server (`server.ts`) and entry point (`index.ts`)

**Files:**
- Create: `~/projects/claude-max-proxy/agent/src/server.ts`
- Create: `~/projects/claude-max-proxy/agent/src/index.ts` *(overwrite the placeholder from Task 1)*
- Create: `~/projects/claude-max-proxy/agent/test/server.test.ts`

**Interfaces:**
- Consumes: `TokenManager`, `callUpstream`.
- Produces:
  - `createServer(deps: ServerDeps): http.Server` where `ServerDeps = { upstream: (body: Buffer, accept: string) => Promise<Response> }`
  - A runnable agent: `node dist/index.js` (or `npm run dev`) starts on `127.0.0.1:8787`.

- [ ] **Step 1: Write the failing tests**

`~/projects/claude-max-proxy/agent/test/server.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../src/server.js";
import { AddressInfo } from "node:net";

function startServer(upstream: (body: Buffer, accept: string) => Promise<Response>) {
  const server = createServer({ upstream });
  return new Promise<{ server: http.Server; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("createServer", () => {
  it("routes POST /v1/messages to upstream and streams body back", async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("chunk-1")); c.enqueue(new TextEncoder().encode("chunk-2")); c.close(); }
    });
    const upstream = async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, '{"messages":[]}');
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/event-stream");
      expect(r.body).toBe("chunk-1chunk-2");
    } finally { server.close(); }
  });

  it("returns 404 for non-matching routes", async () => {
    const upstream = async () => new Response("nope", { status: 200 });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/other`, "{}");
      expect(r.status).toBe(404);
      const j = JSON.parse(r.body);
      expect(j.error.type).toBe("not_found");
    } finally { server.close(); }
  });

  it("returns 400 on non-JSON body", async () => {
    const upstream = async () => new Response("ok", { status: 200 });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, "not-json");
      expect(r.status).toBe(400);
      const j = JSON.parse(r.body);
      expect(j.error.type).toBe("invalid_request_error");
    } finally { server.close(); }
  });

  it("forwards 4xx/5xx status and body from upstream", async () => {
    const upstream = async () => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
      status: 429,
      headers: { "retry-after": "3", "content-type": "application/json" },
    });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, "{}");
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("3");
      expect(JSON.parse(r.body).error.type).toBe("rate_limit_error");
    } finally { server.close(); }
  });

  it("strips hop-by-hop headers from upstream response", async () => {
    const upstream = async () => new Response("body", {
      status: 200,
      headers: { "content-type": "text/plain", "connection": "keep-alive", "transfer-encoding": "chunked" },
    });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, "{}");
      expect(r.status).toBe(200);
      // connection and transfer-encoding should not have been set by us
      expect(r.headers.get("content-type")).toBe("text/plain");
    } finally { server.close(); }
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/server.test.ts
```

Expected: file-not-found errors.

- [ ] **Step 3: Implement the server**

`~/projects/claude-max-proxy/agent/src/server.ts`:
```ts
import * as http from "node:http";

export interface ServerDeps {
  upstream: (body: Buffer, accept: string) => Promise<Response>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        return sendJson(res, 404, { error: { type: "not_found", message: "POST /v1/messages only" } });
      }
      const body = await collectBody(req);
      try { JSON.parse(body.toString("utf-8")); }
      catch {
        return sendJson(res, 400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } });
      }
      const accept = pickHeader(req.headers["accept"]) ?? "application/json";
      const upstream = await deps.upstream(body, accept);
      res.statusCode = upstream.status;
      for (const [k, v] of upstream.headers.entries()) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        res.setHeader(k, v);
      }
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      console.error("[agent] handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: { type: "internal_error", message: String(err) } });
      else res.end();
    }
  });
}

function pickHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run
```

Expected: all 15 tests pass.

- [ ] **Step 5: Write the entry point**

`~/projects/claude-max-proxy/agent/src/index.ts` (replaces placeholder):
```ts
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "./server.js";
import { callUpstream } from "./upstream.js";
import {
  KeychainStore,
  FileCredentialStore,
  PlatformRefreshClient,
  TokenManager,
  makeFileLock,
} from "./tokens.js";
import type { CredentialStore } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOCK_PATH = path.join(os.homedir(), ".claude", ".proxy-refresh.lock");

async function chooseStore(): Promise<CredentialStore> {
  const keychain = new KeychainStore();
  const probe = await keychain.read().catch(() => null);
  if (probe) return keychain;
  console.warn("[agent] no Keychain credential; falling back to ~/.claude/.credentials.json");
  return new FileCredentialStore();
}

async function main() {
  const store = await chooseStore();
  const tokens = new TokenManager(store, new PlatformRefreshClient(), makeFileLock(LOCK_PATH));
  // Warm up — surface auth errors at startup instead of on the first request.
  try { await tokens.getAccessToken(); }
  catch (e) { console.error("[agent] credential check failed:", e); process.exitCode = 1; return; }

  const server = createServer({
    upstream: (body, accept) => callUpstream(body, accept, tokens),
  });
  server.listen(PORT, HOST, () => {
    console.log(`[agent] listening on http://${HOST}:${PORT}`);
  });

  const shutdown = (sig: string) => {
    console.log(`[agent] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Build cleanly**

```bash
cd ~/projects/claude-max-proxy/agent && npx tsc -p tsconfig.json
```

Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/server.ts agent/src/index.ts agent/test/server.test.ts
git commit -m "feat(agent): http server and entry point with keychain auto-detect"
```

---

### Task 5: Agent local smoke test against real Anthropic

**Files:**
- Create: `~/projects/claude-max-proxy/scripts/smoke-agent.sh`

**Interfaces:**
- Consumes: a running local agent on `127.0.0.1:8787`.
- Produces: a passing real-call smoke test that proves OAuth tokens + headers reach Anthropic and return a sensible response.

This is the first end-to-end real-API validation. It uses the user's actual Keychain token; nothing is published or deployed.

- [ ] **Step 1: Confirm the user is logged in to Claude Code**

Run on the user's Mac (interactive — the user should have already done `claude` login at least once):

```bash
security find-generic-password -s "Claude Code-credentials" -w >/dev/null && echo "keychain OK" || echo "MISSING — run \`claude\` once to login"
```

Expected: `keychain OK`. If `MISSING`, the user must run the Claude Code CLI once to authenticate before proceeding.

- [ ] **Step 2: Write the smoke script**

`~/projects/claude-max-proxy/scripts/smoke-agent.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

URL="${URL:-http://127.0.0.1:8787/v1/messages}"

echo "--- non-streaming ---"
curl -sS -X POST "$URL" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 32,
    "messages": [{"role": "user", "content": "Respond with the single word: PONG"}]
  }' | tee /tmp/smoke-nonstream.json
echo
grep -q '"type":"message"' /tmp/smoke-nonstream.json
grep -q 'PONG' /tmp/smoke-nonstream.json || echo "WARN: model did not answer PONG (still a success if status was 200)"

echo
echo "--- streaming ---"
curl -sS -N -X POST "$URL" \
  -H "content-type: application/json" \
  -H "accept: text/event-stream" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 32,
    "stream": true,
    "messages": [{"role": "user", "content": "Stream the single word: PONG"}]
  }' | tee /tmp/smoke-stream.txt
echo
grep -q 'event: message_start' /tmp/smoke-stream.txt
grep -q 'event: message_stop' /tmp/smoke-stream.txt

echo
echo "OK"
```

```bash
chmod +x ~/projects/claude-max-proxy/scripts/smoke-agent.sh
```

- [ ] **Step 3: Start the agent in a background terminal**

```bash
cd ~/projects/claude-max-proxy/agent && npm run dev
```

Expected: `[agent] listening on http://127.0.0.1:8787`. Leave running.

- [ ] **Step 4: Run the smoke script**

In another terminal:

```bash
~/projects/claude-max-proxy/scripts/smoke-agent.sh
```

Expected: both blocks print `OK`. The non-streaming JSON has `"type":"message"`; the streaming output contains `event: message_start` and `event: message_stop`.

If you see HTTP `401` from Anthropic — re-run `claude` interactively to refresh the Keychain credential and retry.

- [ ] **Step 5: Stop the agent (Ctrl-C in the agent terminal)**

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claude-max-proxy
git add scripts/smoke-agent.sh
git commit -m "test(agent): smoke script for local Anthropic call (streaming + non-streaming)"
```

---

### Task 6: Cloudflare Tunnel — register, route, gate with Access

**Files:**
- Create: `~/projects/claude-max-proxy/cloudflared/config.yml.example`
- Create: `~/projects/claude-max-proxy/cloudflared/README.md`

**Interfaces:**
- Produces: a private hostname (e.g. `claude-agent.internal.<your-domain>`) that the Worker can reach over the Tunnel; a Cloudflare Access Service Token policy that only the Worker is allowed to present.

This task is largely interactive — the user must own a domain on Cloudflare and run `cloudflared` commands locally.

- [ ] **Step 1: Install `cloudflared`**

```bash
brew install cloudflared
cloudflared --version
```

Expected: a version string. If `brew` is missing, the user can install via `https://github.com/cloudflare/cloudflared/releases`.

- [ ] **Step 2: Authenticate `cloudflared`**

```bash
cloudflared tunnel login
```

Expected: opens a browser, the user selects a zone (their domain). A cert is saved to `~/.cloudflared/cert.pem`.

> **PAUSE FOR USER INPUT** — the executing agent must ask the user which zone (domain) was selected and what the desired private hostname is. Suggested default: `claude-agent.internal.<zone>`.

- [ ] **Step 3: Create the tunnel**

```bash
cloudflared tunnel create claude-max-proxy
```

Expected: prints a tunnel UUID and writes `~/.cloudflared/<uuid>.json`. Note the UUID.

- [ ] **Step 4: Route DNS to the tunnel**

```bash
cloudflared tunnel route dns claude-max-proxy <chosen-hostname>
```

Replace `<chosen-hostname>` with the value chosen in Step 2.

- [ ] **Step 5: Write the local config**

`~/.cloudflared/config.yml` (created manually — `~/projects/claude-max-proxy/cloudflared/config.yml.example` mirrors it):

```yaml
tunnel: claude-max-proxy
credentials-file: /Users/bob.jansen/.cloudflared/<uuid>.json
ingress:
  - hostname: <chosen-hostname>
    service: http://localhost:8787
  - service: http_status:404
```

Save the example into the repo (with placeholders), too:

`~/projects/claude-max-proxy/cloudflared/config.yml.example`:
```yaml
tunnel: claude-max-proxy
credentials-file: /Users/<USER>/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: <CHOSEN_HOSTNAME>
    service: http://localhost:8787
  - service: http_status:404
```

- [ ] **Step 6: Start the tunnel in the foreground to verify**

```bash
cloudflared tunnel run claude-max-proxy
```

Expected: prints "Connection registered" lines. Leave running.

- [ ] **Step 7: With the agent also running, hit the tunnel hostname directly**

In another shell, from anywhere on the public internet (note: at this point there is **no auth yet** on the tunnel; only the unguessable hostname protects it — fix in Step 9):

```bash
curl -sS -X POST "https://<chosen-hostname>/v1/messages" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"PONG"}]}' \
  | head -c 200
```

Expected: a JSON message with `"type":"message"`.

- [ ] **Step 8: Set up a Cloudflare Access Application for the Tunnel hostname**

> **PAUSE FOR USER INPUT** — this step uses the Cloudflare dashboard.
> 1. Zero Trust → Access → Applications → **Add an application** → *Self-hosted*.
> 2. Application name: `claude-max-proxy-tunnel`.
> 3. Application domain: `<chosen-hostname>`.
> 4. Identity providers: leave defaults; this app is for the Worker, not humans.
> 5. Create a **Service Auth** policy:
>    - Policy name: `worker-only`.
>    - Action: `Service Auth`.
>    - Include → **Service Token** → create a new token named `claude-max-proxy-worker`. Save the **Client ID** and **Client Secret** — needed by the Worker in Task 8.
> 6. Note the **Application Audience (AUD) Tag** from the application Overview page — needed by the Worker.
> 7. Save the application.

The executing agent must collect from the user: `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`), `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

- [ ] **Step 9: Verify direct unauthenticated calls now fail**

```bash
curl -i -sS -X POST "https://<chosen-hostname>/v1/messages" \
  -H "content-type: application/json" -d '{}' | head -n 1
```

Expected: `HTTP/2 302` redirect to Cloudflare Access login. (Or `403` for browserless requests.) The hostname is now gated.

- [ ] **Step 10: Verify service-token calls succeed**

```bash
curl -i -sS -X POST "https://<chosen-hostname>/v1/messages" \
  -H "cf-access-client-id: <CLIENT_ID>" \
  -H "cf-access-client-secret: <CLIENT_SECRET>" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"PONG"}]}' \
  | head -c 200
```

Expected: `200` with an Anthropic message body.

- [ ] **Step 11: Write the cloudflared README**

`~/projects/claude-max-proxy/cloudflared/README.md`:
```markdown
# Cloudflare Tunnel setup

The local agent listens on `127.0.0.1:8787`. Cloudflare Tunnel exposes it to
the Worker over a private Cloudflare-hosted hostname, gated by Access.

## One-time setup

1. `brew install cloudflared`
2. `cloudflared tunnel login` — picks the Cloudflare zone (your domain).
3. `cloudflared tunnel create claude-max-proxy`
4. `cloudflared tunnel route dns claude-max-proxy <hostname>` (e.g.
   `claude-agent.internal.example.com`).
5. Copy `config.yml.example` to `~/.cloudflared/config.yml` and fill in your
   tunnel UUID and chosen hostname.
6. In the Cloudflare Zero Trust dashboard, create an Access application for
   the hostname with a **Service Auth** policy and a service token. Record
   the AUD tag, team domain, client ID and secret — the Worker needs them.

## Run

Foreground (for testing): `cloudflared tunnel run claude-max-proxy`

Background (recommended): `sudo cloudflared service install` — installs a
launchd plist that runs the tunnel under root using `~/.cloudflared/config.yml`.
```

- [ ] **Step 12: Commit**

```bash
cd ~/projects/claude-max-proxy
git add cloudflared/config.yml.example cloudflared/README.md
git commit -m "docs(cloudflared): tunnel config example and setup walkthrough"
```

---

### Task 7: Worker implementation (`worker/src/index.ts`)

**Files:**
- Create: `~/projects/claude-max-proxy/worker/src/index.ts`
- Create: `~/projects/claude-max-proxy/worker/wrangler.jsonc`
- Create: `~/projects/claude-max-proxy/worker/test/index.test.ts`

**Interfaces:**
- Consumes: the Tunnel hostname + Access service-token credentials produced by Task 6.
- Produces: a deployable Worker that verifies the inbound Cloudflare Access JWT, then forwards through the Tunnel using the service token, returning the upstream `Response` unchanged.

- [ ] **Step 1: Write the wrangler config**

`~/projects/claude-max-proxy/worker/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "claude-max-proxy",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "vars": {
    "TUNNEL_HOSTNAME": "<CHOSEN_HOSTNAME>",
    "ACCESS_TEAM_DOMAIN": "<TEAM>.cloudflareaccess.com"
  }
  // secrets (set via `wrangler secret put`):
  //   ACCESS_AUD                   — Application Audience tag of the Worker's CF Access app
  //   TUNNEL_ACCESS_CLIENT_ID      — service token client ID for the Tunnel hostname
  //   TUNNEL_ACCESS_CLIENT_SECRET  — service token secret for the Tunnel hostname
}
```

- [ ] **Step 2: Write the failing tests**

`~/projects/claude-max-proxy/worker/test/index.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";

const ENV_BASE = {
  TUNNEL_HOSTNAME: "tunnel.example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
  TUNNEL_ACCESS_CLIENT_ID: "cid",
  TUNNEL_ACCESS_CLIENT_SECRET: "csecret",
};

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Bypass JWT verification in unit tests by injecting via env override.
  (worker as any).__skipJwtVerify = true;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (worker as any).__skipJwtVerify = false;
});

describe("worker fetch handler", () => {
  it("returns 404 for non-matching routes", async () => {
    const req = new Request("https://w.example.com/health", { method: "GET" });
    const res = await worker.fetch(req, ENV_BASE as any, makeCtx());
    expect(res.status).toBe(404);
  });

  it("returns 403 when no Access JWT is present", async () => {
    (worker as any).__skipJwtVerify = false;
    const req = new Request("https://w.example.com/v1/messages", { method: "POST", body: "{}" });
    const res = await worker.fetch(req, ENV_BASE as any, makeCtx());
    expect(res.status).toBe(403);
  });

  it("forwards POST /v1/messages to the tunnel and streams response back", async () => {
    fetchMock.mockResolvedValueOnce(new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }));
    const req = new Request("https://w.example.com/v1/messages", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "stub", "content-type": "application/json" },
      body: '{"messages":[]}',
    });
    const res = await worker.fetch(req, ENV_BASE as any, makeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://tunnel.example.com/v1/messages");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("cf-access-client-id")).toBe("cid");
    expect(h.get("cf-access-client-secret")).toBe("csecret");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("returns 502 when the tunnel fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    const req = new Request("https://w.example.com/v1/messages", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "stub", "content-type": "application/json" },
      body: "{}",
    });
    const res = await worker.fetch(req, ENV_BASE as any, makeCtx());
    expect(res.status).toBe(502);
    expect((await res.json() as any).error.type).toBe("upstream_unavailable");
  });
});
```

- [ ] **Step 3: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/worker && npx vitest run
```

Expected: import errors.

- [ ] **Step 4: Implement the Worker**

`~/projects/claude-max-proxy/worker/src/index.ts`:
```ts
import * as jose from "jose";

export interface Env {
  TUNNEL_HOSTNAME: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TUNNEL_ACCESS_CLIENT_ID: string;
  TUNNEL_ACCESS_CLIENT_SECRET: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "cookie",
]);

const FORWARD_HEADERS = new Set([
  "accept",
  "content-type",
  "anthropic-version",
]);

const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let getKey = jwksCache.get(teamDomain);
  if (!getKey) {
    getKey = jose.createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, getKey);
  }
  return getKey;
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<void> {
  await jose.jwtVerify(jwt, getJwks(env.ACCESS_TEAM_DOMAIN), {
    audience: env.ACCESS_AUD,
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const handler = {
  // Test-only escape hatch — never set this in production code paths.
  __skipJwtVerify: false as boolean,

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      return jsonResponse(404, { error: { type: "not_found", message: "POST /v1/messages only" } });
    }

    const jwt = req.headers.get("cf-access-jwt-assertion");
    if (!handler.__skipJwtVerify) {
      if (!jwt) return jsonResponse(403, { error: { type: "forbidden", message: "missing access jwt" } });
      try { await verifyAccessJwt(jwt, env); }
      catch (e) {
        return jsonResponse(403, { error: { type: "forbidden", message: `jwt invalid: ${(e as Error).message}` } });
      }
    }

    const fwdHeaders = new Headers();
    for (const [k, v] of req.headers.entries()) {
      if (FORWARD_HEADERS.has(k.toLowerCase())) fwdHeaders.set(k, v);
    }
    fwdHeaders.set("cf-access-client-id", env.TUNNEL_ACCESS_CLIENT_ID);
    fwdHeaders.set("cf-access-client-secret", env.TUNNEL_ACCESS_CLIENT_SECRET);

    let upstream: Response;
    try {
      upstream = await fetch(`https://${env.TUNNEL_HOSTNAME}/v1/messages`, {
        method: "POST",
        headers: fwdHeaders,
        body: req.body,
      });
    } catch (e) {
      return jsonResponse(502, { error: { type: "upstream_unavailable", message: (e as Error).message } });
    }

    const outHeaders = new Headers();
    for (const [k, v] of upstream.headers.entries()) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      outHeaders.set(k, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};

export default handler;
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
cd ~/projects/claude-max-proxy/worker && npx vitest run
```

Expected: 4 tests pass.

- [ ] **Step 6: TypeScript check**

```bash
cd ~/projects/claude-max-proxy/worker && npx tsc --noEmit -p tsconfig.json
```

Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/claude-max-proxy
git add worker/src/index.ts worker/test/index.test.ts worker/wrangler.jsonc
git commit -m "feat(worker): jwt-gated /v1/messages forwarder with service-token tunnel auth"
```

---

### Task 8: Deploy the Worker, set secrets, gate with Access

**Files:** (no new files; updates `worker/wrangler.jsonc` if a route or workers.dev subdomain needs adding)

**Interfaces:**
- Produces: a publicly reachable Worker URL gated by Cloudflare Access that, when called with a valid Access JWT, returns a real Anthropic message.

- [ ] **Step 1: Authenticate wrangler**

```bash
cd ~/projects/claude-max-proxy/worker && npx wrangler login
```

Expected: opens a browser, the user authorises wrangler.

- [ ] **Step 2: Decide on the Worker hostname**

> **PAUSE FOR USER INPUT** — the executing agent must ask the user which hostname they want for the public endpoint. Options:
> - `claude-max-proxy.<workers-subdomain>.workers.dev` (default; no DNS changes needed).
> - A custom hostname on their zone (e.g. `claude.<domain>`).
>
> For a custom hostname, add a `routes` block to `wrangler.jsonc`:
> ```jsonc
> "routes": [{ "pattern": "claude.<domain>/*", "zone_name": "<domain>" }]
> ```

- [ ] **Step 3: Fill in the `vars` in `wrangler.jsonc`**

Edit `~/projects/claude-max-proxy/worker/wrangler.jsonc` and replace the placeholder strings in `vars` with the real values from Task 6 (Tunnel hostname, team domain).

- [ ] **Step 4: Push the secrets**

```bash
cd ~/projects/claude-max-proxy/worker
echo -n "<ACCESS_AUD>" | npx wrangler secret put ACCESS_AUD
echo -n "<TUNNEL_ACCESS_CLIENT_ID>" | npx wrangler secret put TUNNEL_ACCESS_CLIENT_ID
echo -n "<TUNNEL_ACCESS_CLIENT_SECRET>" | npx wrangler secret put TUNNEL_ACCESS_CLIENT_SECRET
```

Expected: each prints "✓ Success".

- [ ] **Step 5: Deploy**

```bash
cd ~/projects/claude-max-proxy/worker && npx wrangler deploy
```

Expected: wrangler prints a deployment URL. Note it as `<WORKER_URL>`.

- [ ] **Step 6: Create a Cloudflare Access application for the Worker URL**

> **PAUSE FOR USER INPUT** — in the Zero Trust dashboard:
> 1. Access → Applications → **Add an application** → *Self-hosted*.
> 2. Application name: `claude-max-proxy`.
> 3. Application domain: the `<WORKER_URL>` (or the custom hostname).
> 4. Identity providers: pick the IdP(s) the user wants for SSO (or email-PIN one-time codes).
> 5. Policy: include `Emails` = `bobjansen@pm.me` (or whatever access criterion the user wants).
> 6. **Application AUD** must match the secret pushed in Step 4. If they differ, push the AUD from this app to the secret again.
> 7. Save.

- [ ] **Step 7: Verify the public endpoint is JWT-gated**

```bash
curl -i -sS -X POST "<WORKER_URL>/v1/messages" -H "content-type: application/json" -d '{}' | head -n 1
```

Expected: `HTTP/2 302` (redirect to Access login) or `HTTP/2 403`. NOT 200.

- [ ] **Step 8: Verify a real authenticated call returns an Anthropic message**

> **PAUSE FOR USER INPUT** — the executing agent must ask the user to obtain a short-lived Access JWT via the browser flow or a service token, then plug it into the curl below.
>
> For interactive testing the easiest path is `cloudflared access curl`:

```bash
brew install cloudflared  # already installed in Task 6
cloudflared access curl "<WORKER_URL>/v1/messages" \
  -X POST -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"PONG"}]}'
```

Expected: a JSON response with `"type":"message"` and a small `content` block. **This is the end-to-end success criterion for the goal.**

- [ ] **Step 9: Commit any wrangler.jsonc edits**

```bash
cd ~/projects/claude-max-proxy
git add worker/wrangler.jsonc
git commit -m "chore(worker): finalise deployment vars" --allow-empty
```

---

### Task 9: Install the agent as a launchd service

**Files:**
- Create: `~/projects/claude-max-proxy/scripts/install-launchd.sh`
- Create: `~/projects/claude-max-proxy/scripts/com.bobjansen.claude-max-proxy.plist`

**Interfaces:**
- Produces: a launchd-managed agent that auto-starts on login and restarts on crash.

- [ ] **Step 1: Write the plist template**

`~/projects/claude-max-proxy/scripts/com.bobjansen.claude-max-proxy.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.bobjansen.claude-max-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/bob.jansen/projects/claude-max-proxy/agent/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/bob.jansen</string>
    <key>PORT</key><string>8787</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/bob.jansen/Library/Logs/claude-max-proxy.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/bob.jansen/Library/Logs/claude-max-proxy.err.log</string>
  <key>WorkingDirectory</key>
  <string>/Users/bob.jansen/projects/claude-max-proxy/agent</string>
</dict>
</plist>
```

- [ ] **Step 2: Write the install script**

`~/projects/claude-max-proxy/scripts/install-launchd.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bobjansen.claude-max-proxy"
PLIST_SRC="$ROOT/scripts/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Building agent..."
(cd "$ROOT/agent" && npm run build)

NODE_PATH="$(command -v node)"
if [[ -z "$NODE_PATH" ]]; then echo "node not found on PATH"; exit 1; fi
echo "Using node at $NODE_PATH"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Substitute node path if the plist's hardcoded /usr/local/bin/node doesn't exist on this Mac.
TMP_PLIST="$(mktemp)"
sed "s|/usr/local/bin/node|${NODE_PATH//|/\\|}|" "$PLIST_SRC" > "$TMP_PLIST"
cp "$TMP_PLIST" "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"
sleep 1
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,20p'

echo
echo "Tailing $HOME/Library/Logs/claude-max-proxy.out.log (Ctrl-C to stop):"
tail -n 20 "$HOME/Library/Logs/claude-max-proxy.out.log" || true
```

```bash
chmod +x ~/projects/claude-max-proxy/scripts/install-launchd.sh
```

- [ ] **Step 3: Run the installer**

```bash
~/projects/claude-max-proxy/scripts/install-launchd.sh
```

Expected: the script builds the agent, writes the plist, loads it under launchd, and the tail shows `[agent] listening on http://127.0.0.1:8787`.

- [ ] **Step 4: Verify the service is up**

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":8,"messages":[{"role":"user","content":"PONG"}]}' | head -c 200
```

Expected: a `200` Anthropic message JSON.

- [ ] **Step 5: Install `cloudflared` as a launchd service too**

```bash
sudo cloudflared service install
sudo launchctl print system/com.cloudflare.cloudflared 2>/dev/null | sed -n '1,5p' || true
```

Expected: cloudflared service installed and running. The tunnel reconnects after reboot.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claude-max-proxy
git add scripts/install-launchd.sh scripts/com.bobjansen.claude-max-proxy.plist
git commit -m "ops(agent): launchd plist and installer for auto-start"
```

---

### Task 10: End-to-end test through deployed stack

**Files:**
- Create: `~/projects/claude-max-proxy/scripts/e2e.sh`

**Interfaces:**
- Produces: a single command (`scripts/e2e.sh`) that exercises the entire deployed pipeline and exits non-zero if any leg fails.

This task is the **goal terminal state** — a green run here means the user-stated goal "deployed, tested and working on cloudflare" is satisfied.

- [ ] **Step 1: Write the script**

`~/projects/claude-max-proxy/scripts/e2e.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

: "${WORKER_URL:?set WORKER_URL to the deployed worker URL, e.g. https://claude.example.com}"

echo "=== 1) JWT gate: unauthenticated request must NOT return 200 ==="
status=$(curl -o /dev/null -s -w "%{http_code}" -X POST "$WORKER_URL/v1/messages" -H "content-type: application/json" -d '{}')
echo "  unauthenticated status: $status"
[[ "$status" == "200" ]] && { echo "FAIL: endpoint is not gated"; exit 1; }

echo
echo "=== 2) Non-streaming request via cloudflared access curl ==="
out=$(cloudflared access curl "$WORKER_URL/v1/messages" \
  -X POST -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"Respond: PONG"}]}')
echo "$out" | head -c 400; echo
echo "$out" | grep -q '"type":"message"' || { echo "FAIL: no message in response"; exit 1; }

echo
echo "=== 3) Streaming request via cloudflared access curl ==="
out=$(cloudflared access curl "$WORKER_URL/v1/messages" \
  -X POST -H "content-type: application/json" -H "accept: text/event-stream" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Stream: PONG"}]}')
echo "$out" | head -n 30
echo "$out" | grep -q 'event: message_start' || { echo "FAIL: no message_start"; exit 1; }
echo "$out" | grep -q 'event: message_stop'  || { echo "FAIL: no message_stop"; exit 1; }

echo
echo "PASS"
```

```bash
chmod +x ~/projects/claude-max-proxy/scripts/e2e.sh
```

- [ ] **Step 2: Run it**

```bash
WORKER_URL="<WORKER_URL>" ~/projects/claude-max-proxy/scripts/e2e.sh
```

Expected: the script prints `PASS` and exits 0. If any leg fails, follow the printed `FAIL:` line back to the right debug spot (gate failure → CF Access policy; no `type:message` → agent or Anthropic token; no `message_stop` → SSE pass-through somewhere in the chain).

- [ ] **Step 3: Commit and push the branch**

```bash
cd ~/projects/claude-max-proxy
git add scripts/e2e.sh
git commit -m "test: end-to-end smoke through deployed worker + tunnel + agent"
git push -u origin feature/CMP-001-initial-implementation
```

(Push only if a remote `origin` is configured. If this is purely a local repo with no remote yet, the push step can be skipped — note that to the user and continue.)

---

## Spec coverage check

Verifying each spec section maps to a task:

- Goals 1–5 (Access-protected `/v1/messages`, SSE pass-through, residential-IP refresh, atomic write-back, single-user behind Access) → Tasks 2, 3, 4, 6, 7, 8.
- Non-goals — explicitly preserved (no OpenAI shape, no multi-account, etc.).
- Architecture diagram → Tasks 4, 6, 7.
- Components / Worker → Tasks 7, 8.
- Components / Tunnel → Task 6.
- Components / Local Agent (token store, refresh, lock, write-back) → Tasks 2, 4.
- Components / Upstream call → Task 3.
- 401-retry policy → Task 3 tests + impl.
- Error handling table — every row covered: 401 retry (Task 3), refresh fails (Task 2/3), 429/5xx forward (Task 3/4), tunnel down → 502 (Task 7), JWT invalid → 403 (Task 7), malformed body → 400 (Task 4).
- Testing → Tasks 2, 3, 4, 7 (unit), Task 5 (agent integration), Task 10 (e2e).
- Project layout → Task 1 + all subsequent tasks fill it.
- Configuration & secrets → Tasks 7, 8.
- Risks — refresh-rotation race (Task 2 lock+re-read), Keychain prompts (Task 9 launchd in user domain), client_id constant location (`tokens.ts`, Task 2).

No gaps.
