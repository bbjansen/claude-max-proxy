# Keychain rename + Claude Code routing + Cloudflare rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three remaining renames in one branch: Keychain service `claude-max-proxy-credentials` → `claudette-credentials` (with chained migration), per-session account pinning for Claude Code via `X-Account-Hint`, and a blue/green rename of the live Cloudflare Worker/Tunnel/hostname to `claudette` with PROXY_KEY rotation.

**Architecture:** Code changes ship first (Keychain constant, chained migrator, hint-aware selector, Worker forward-headers). Then a phased Cloudflare migration: stand up green stack (new Tunnel + DNS + Access + Worker) alongside blue (existing `claude-max-proxy.*`), verify end-to-end, switch Claude Code's `~/.claude/settings.json` to the new URL, tear down blue.

**Tech Stack:** TypeScript / Node 20+, Cloudflare API (Tunnel, DNS, Worker secrets), `wrangler`, `cloudflared`, `launchctl`, `vitest`.

## Global Constraints

- Branch off `main`: `feature/CMP-004-claudette-completion` (already exists, spec committed there as `ffa2ea5`).
- Repo on disk: `~/projects/claudette/`.
- Keychain service constant: `claudette-credentials` (new), `claude-max-proxy-credentials` (secondary migration source), `Claude Code-credentials` (primary migration source).
- Cloudflare account ID: `64f75ad3008e37e68b03ebbedefc89ed`.
- Cloudflare zone: `bobjansen.dev`.
- CF API token: `~/.claude-max-proxy.cf` (filename retained; contents unchanged).
- New PROXY_KEY file: `~/.claudette.key` (mode 0600).
- New hostname: `claudette-agent.bobjansen.dev`.
- New Worker name: `claudette` (URL becomes `claudette.bobjansen.workers.dev`).
- Old resources: Worker `claude-max-proxy`, Tunnel `claude-max-proxy`, DNS `claude-agent.bobjansen.dev`, Access app for old hostname.
- Header convention: `X-Account-Hint` (case-insensitive; HTTP normalizes to lowercase in Node's `req.headers`).
- All test code changes precede live Cloudflare changes.
- Commits: conventional, no co-author, no AI references.

---

### Task 1: Pool — accept and honor `hint` in `pickToken`

**Files:**
- Modify: `agent/src/pool.ts`
- Modify: `agent/test/pool.test.ts`

**Interfaces:**
- Consumes: existing `AccountPool`, `ModelTier`, `AccountId`.
- Produces: `pickToken(tier: ModelTier, exclude?: AccountId[], hint?: AccountId | null): Promise<{ acctId: AccountId; token: string }>`. Hint is a non-blocking preference: when set AND valid AND not cooled, return it; otherwise fall through to existing round-robin.

- [ ] **Step 1: Append failing tests to `agent/test/pool.test.ts`**

In `agent/test/pool.test.ts`, append below the existing `describe("AccountPool — admin surface", ...)` block:

```ts
describe("AccountPool — pickToken hint", () => {
  const NOW = 1_700_000_000_000;
  const clock = () => NOW;
  const A = { acctId: "a@x", manager: fakeManager("tok-A") };
  const B = { acctId: "b@y", manager: fakeManager("tok-B") };
  const C = { acctId: "c@z", manager: fakeManager("tok-C") };

  it("honors a valid hint (not cooled, not disabled, in pool)", async () => {
    const p = new AccountPool([A, B, C], { clock });
    const pick = await p.pickToken("opus", [], "c@z");
    expect(pick.acctId).toBe("c@z");
  });

  it("does not advance nextIdx when honoring a hint", async () => {
    const p = new AccountPool([A, B, C], { clock });
    await p.pickToken("opus", [], "c@z"); // hint
    const next = await p.pickToken("opus"); // no hint — should be A (nextIdx untouched)
    expect(next.acctId).toBe("a@x");
  });

  it("ignores the hint when the hinted account is cooled for the tier", async () => {
    const p = new AccountPool([A, B, C], { clock });
    p.markCooldown("c@z", "opus", NOW + 60_000);
    const pick = await p.pickToken("opus", [], "c@z");
    expect(pick.acctId).toBe("a@x"); // round-robin from nextIdx=0
  });

  it("ignores the hint when the hinted account is manually disabled", async () => {
    const p = new AccountPool([A, B, C], { clock });
    p.setManuallyDisabled("c@z", true);
    const pick = await p.pickToken("opus", [], "c@z");
    expect(pick.acctId).toBe("a@x");
  });

  it("ignores the hint when the hinted account is unknown", async () => {
    const p = new AccountPool([A, B, C], { clock });
    const pick = await p.pickToken("opus", [], "ghost@x");
    expect(pick.acctId).toBe("a@x");
  });

  it("ignores the hint when the hinted account is in exclude", async () => {
    const p = new AccountPool([A, B, C], { clock });
    const pick = await p.pickToken("opus", ["c@z"], "c@z");
    expect(pick.acctId).toBe("a@x");
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claudette/agent && npx vitest run test/pool.test.ts 2>&1 | tail -10
```

Expected: 6 new tests fail (extra arg to `pickToken` not yet supported, or hint path not yet wired).

- [ ] **Step 3: Implement the hint check in `pool.ts`**

In `agent/src/pool.ts`, replace the existing `pickToken` method signature and body. Locate the existing method:

```ts
async pickToken(tier: ModelTier, exclude: AccountId[] = []): Promise<{ acctId: AccountId; token: string }> {
```

Change to:

```ts
async pickToken(tier: ModelTier, exclude: AccountId[] = [], hint: AccountId | null = null): Promise<{ acctId: AccountId; token: string }> {
  const order = this.accounts();
  if (order.length === 0) throw new Error("AccountPool is empty");

  const excludeSet = new Set(exclude);
  const eligible = order.filter(id => !excludeSet.has(id) && !this.disabled.has(id));
  if (eligible.length === 0) throw new Error("no eligible account after applying exclude list / disabled flags");

  const now = this.clock();

  // 1. Honor a valid hint as a non-rotating preference.
  if (hint !== null
      && this.managers.has(hint)
      && !excludeSet.has(hint)
      && !this.disabled.has(hint)) {
    const until = this.cooldown.get(hint)?.get(tier) ?? 0;
    if (until <= now) {
      return this.use(hint, now);
    }
  }

  // 2. Round-robin scan for the first eligible, non-cooled candidate.
  for (let i = 0; i < order.length; i++) {
    const idx = (this.nextIdx + i) % order.length;
    const acctId = order[idx]!;
    if (excludeSet.has(acctId) || this.disabled.has(acctId)) continue;
    const until = this.cooldown.get(acctId)?.get(tier) ?? 0;
    if (until <= now) {
      this.nextIdx = (idx + 1) % order.length;
      return this.use(acctId, now);
    }
  }

  // 3. Every eligible account is cooled for the tier. Pick the soonest-expiring.
  let bestId: AccountId | null = null;
  let bestUntil = Number.POSITIVE_INFINITY;
  for (const acctId of eligible) {
    const until = this.cooldown.get(acctId)?.get(tier) ?? Number.POSITIVE_INFINITY;
    if (until < bestUntil) { bestUntil = until; bestId = acctId; }
  }
  if (bestId == null) throw new Error("AccountPool: pickToken found no candidate (unreachable)");
  return this.use(bestId, now);
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/claudette/agent && npx vitest run test/pool.test.ts 2>&1 | tail -8
```

Expected: 22 tests pass (16 existing + 6 new).

- [ ] **Step 5: Type check**

```bash
cd ~/projects/claudette/agent && npx tsc --noEmit -p tsconfig.json; echo "tsc=$?"
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claudette
git add agent/src/pool.ts agent/test/pool.test.ts
git commit -m "feat(agent): AccountPool.pickToken honors optional account hint"
```

---

### Task 2: Upstream — thread `accountHint` through to `pool.pickToken`

**Files:**
- Modify: `agent/src/upstream.ts`
- Modify: `agent/test/upstream.test.ts`

**Interfaces:**
- Consumes: `AccountPool.pickToken(tier, exclude, hint?)` from Task 1.
- Produces: `callUpstreamRotating(body, acceptHeader, pool, opts?)` where `opts` gains `accountHint?: string | null`. The hint is applied on the first attempt only and dropped on retries.

- [ ] **Step 1: Append failing test to `agent/test/upstream.test.ts`**

Inside the existing `describe("callUpstreamRotating", ...)` block, append:

```ts
  it("forwards accountHint to pool.pickToken on the first attempt only", async () => {
    fetchMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    const acctIds = ["a@x", "b@y"];
    const calls: Array<{ tier: string; exclude: string[]; hint: string | null }> = [];
    const pool = {
      pickToken: async (tier: string, exclude: string[], hint: string | null = null) => {
        calls.push({ tier, exclude: [...exclude], hint });
        return { acctId: acctIds[exclude.length] ?? "a@x", token: "t" };
      },
      markCooldown: () => {},
      accounts: () => acctIds,
    } as unknown as AccountPool;

    const body = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5" }));
    await callUpstreamRotating(body, "application/json", pool, { accountHint: "b@y" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.hint).toBe("b@y");
  });

  it("drops accountHint on 429 retry", async () => {
    fetchMock.mockImplementation(async (_url: unknown, _init: unknown) => new Response(
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
      { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
    ));
    const acctIds = ["a@x", "b@y", "c@z"];
    const calls: Array<{ hint: string | null }> = [];
    const pool = {
      pickToken: async (tier: string, exclude: string[], hint: string | null = null) => {
        calls.push({ hint });
        return { acctId: acctIds[exclude.length] ?? "a@x", token: "t" };
      },
      markCooldown: () => {},
      accounts: () => acctIds,
    } as unknown as AccountPool;

    const body = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5" }));
    await callUpstreamRotating(body, "application/json", pool, { accountHint: "b@y" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.hint).toBe("b@y");
    expect(calls[1]!.hint).toBeNull();
  });
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claudette/agent && npx vitest run test/upstream.test.ts 2>&1 | tail -10
```

Expected: type errors / runtime failures because `opts.accountHint` is not yet read.

- [ ] **Step 3: Update `upstream.ts`**

In `agent/src/upstream.ts`, locate:

```ts
interface RotatingOpts {
  maxAttempts?: number;
  nowMs?: () => number;
  log?: (msg: string, extra?: object) => void;
}
```

Change to:

```ts
interface RotatingOpts {
  maxAttempts?: number;
  nowMs?: () => number;
  log?: (msg: string, extra?: object) => void;
  accountHint?: string | null;
}
```

Then locate inside `callUpstreamRotating`:

```ts
  const tried: string[] = [];
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { acctId, token } = await pool.pickToken(tier, tried);
    tried.push(acctId);
```

Change to:

```ts
  const tried: string[] = [];
  let lastResponse: Response | null = null;
  const initialHint = opts.accountHint ?? null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const hint = attempt === 0 ? initialHint : null;
    const { acctId, token } = await pool.pickToken(tier, tried, hint);
    tried.push(acctId);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/claudette/agent && npx vitest run test/upstream.test.ts 2>&1 | tail -10
```

Expected: 9 tests pass (7 existing + 2 new).

- [ ] **Step 5: Type check**

```bash
cd ~/projects/claudette/agent && npx tsc --noEmit -p tsconfig.json; echo "tsc=$?"
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claudette
git add agent/src/upstream.ts agent/test/upstream.test.ts
git commit -m "feat(agent): callUpstreamRotating threads accountHint to pool.pickToken on first attempt"
```

---

### Task 3: Server — extract `x-account-hint` header and pass to upstream

**Files:**
- Modify: `agent/src/server.ts`
- Modify: `agent/test/server.test.ts`

**Interfaces:**
- Consumes: `callUpstreamRotating(body, accept, pool, opts?)` opts-shape from Task 2.
- Produces: `ServerDeps.upstream` signature gains a fourth parameter `accountHint?: string | null`. Server reads `req.headers["x-account-hint"]` (case-folded by Node) and threads it through.

- [ ] **Step 1: Append failing test to `agent/test/server.test.ts`**

Inside `describe("createServer", ...)`, append:

```ts
  it("reads x-account-hint header and passes it to upstream", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const seen: Array<string | null | undefined> = [];
    const upstream = vi.fn(async (_body: Buffer, _accept: string, _p: AccountPool, hint?: string | null) => {
      seen.push(hint);
      return new Response("ok", { status: 200 });
    });
    const { server, url } = await startServer({ pool, upstream });
    try {
      await post(`${url}/v1/messages`, JSON.stringify({ model: "claude-haiku-4-5" }), {
        "X-Account-Hint": "b@y",
      });
      expect(seen).toEqual(["b@y"]);
    } finally { server.close(); }
  });

  it("passes null when x-account-hint header is absent", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const seen: Array<string | null | undefined> = [];
    const upstream = vi.fn(async (_body: Buffer, _accept: string, _p: AccountPool, hint?: string | null) => {
      seen.push(hint ?? null);
      return new Response("ok", { status: 200 });
    });
    const { server, url } = await startServer({ pool, upstream });
    try {
      await post(`${url}/v1/messages`, JSON.stringify({ model: "claude-haiku-4-5" }));
      expect(seen).toEqual([null]);
    } finally { server.close(); }
  });
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claudette/agent && npx vitest run test/server.test.ts 2>&1 | tail -10
```

Expected: failures because the upstream callback isn't invoked with the hint yet.

- [ ] **Step 3: Update `ServerDeps` shape and pass through the hint**

In `agent/src/server.ts`, locate:

```ts
export interface ServerDeps {
  pool: AccountPool;
  upstream: (body: Buffer, accept: string, pool: AccountPool) => Promise<Response>;
}
```

Change to:

```ts
export interface ServerDeps {
  pool: AccountPool;
  upstream: (body: Buffer, accept: string, pool: AccountPool, accountHint?: string | null) => Promise<Response>;
}
```

Then locate `handleMessages`:

```ts
  const accept = pickHeader(req.headers["accept"]) ?? "application/json";
  const upstream = await deps.upstream(body, accept, deps.pool);
```

Change to:

```ts
  const accept = pickHeader(req.headers["accept"]) ?? "application/json";
  const accountHint = pickHeader(req.headers["x-account-hint"]) ?? null;
  const upstream = await deps.upstream(body, accept, deps.pool, accountHint);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/claudette/agent && npx vitest run test/server.test.ts 2>&1 | tail -10
```

Expected: 7 tests pass (5 existing + 2 new).

- [ ] **Step 5: Type check**

```bash
cd ~/projects/claudette/agent && npx tsc --noEmit -p tsconfig.json; echo "tsc=$?"
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claudette
git add agent/src/server.ts agent/test/server.test.ts
git commit -m "feat(agent): server extracts x-account-hint header and threads it to upstream"
```

---

### Task 4: Worker — allow `x-account-hint` through FORWARD_HEADERS

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/test/index.test.ts`

**Interfaces:**
- Consumes: existing Worker `buildTunnelHeaders`.
- Produces: requests with `x-account-hint` get the header forwarded to the Tunnel.

- [ ] **Step 1: Append failing test to `worker/test/index.test.ts`**

Inside `describe("worker routing", ...)`, append:

```ts
  it("forwards x-account-hint header to the tunnel", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const req = new Request("https://w.example.com/v1/messages", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": "stub",
        "content-type": "application/json",
        "x-account-hint": "bob@example.com",
      },
      body: "{}",
    });
    await worker.fetch(req, ENV_BASE as never, makeCtx());
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const h = new Headers(init.headers as HeadersInit);
    expect(h.get("x-account-hint")).toBe("bob@example.com");
  });
```

- [ ] **Step 2: Watch it fail**

```bash
cd ~/projects/claudette/worker && npx vitest run test/index.test.ts 2>&1 | tail -10
```

Expected: the test fails because `x-account-hint` is not in the FORWARD_HEADERS allowlist.

- [ ] **Step 3: Update FORWARD_HEADERS**

In `worker/src/index.ts`, locate:

```ts
const FORWARD_HEADERS = new Set([
  "accept",
  "content-type",
]);
```

Change to:

```ts
const FORWARD_HEADERS = new Set([
  "accept",
  "content-type",
  "x-account-hint",
]);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/claudette/worker && npx vitest run test/index.test.ts 2>&1 | tail -8
```

Expected: 13 tests pass (12 existing + 1 new).

- [ ] **Step 5: Type check**

```bash
cd ~/projects/claudette/worker && npx tsc --noEmit -p tsconfig.json; echo "tsc=$?"
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claudette
git add worker/src/index.ts worker/test/index.test.ts
git commit -m "feat(worker): forward x-account-hint header to the tunnel"
```

---

### Task 5: Migrator — chained secondary source

**Files:**
- Modify: `agent/src/migrate.ts`
- Modify: `agent/test/migrate.test.ts`

**Interfaces:**
- Consumes: existing `runMigrationOnce` and `MigrateDeps`.
- Produces: extended `MigrateDeps` interface with optional `secondaryListOld` + `secondaryReadOld`. When the primary `listOld` returns zero entries AND `secondaryListOld` is provided, iterate the secondary.

- [ ] **Step 1: Append failing tests to `agent/test/migrate.test.ts`**

Append:

```ts
describe("runMigrationOnce — chained secondary source", () => {
  it("uses the secondary source when the primary returns zero entries", async () => {
    const secondary = new Map([
      ["x@s", cred("tX")],
      ["y@s", cred("tY")],
    ]);
    const written: string[] = [];
    const out = await runMigrationOnce({
      listOld: async () => [],
      readOld: async () => null,
      listNew: async () => [],
      writeNew: async (id) => { written.push(id); },
      secondaryListOld: async () => [...secondary.keys()],
      secondaryReadOld: async (id) => secondary.get(id) ?? null,
    });
    expect(out).toEqual({ migrated: 2, skipped: [] });
    expect(written.sort()).toEqual(["x@s", "y@s"]);
  });

  it("does NOT consult the secondary source when the primary had entries", async () => {
    const primary = new Map([["p@x", cred("tP")]]);
    let secondaryCalled = false;
    const out = await runMigrationOnce({
      listOld: async () => [...primary.keys()],
      readOld: async (id) => primary.get(id) ?? null,
      listNew: async () => [],
      writeNew: async () => {},
      secondaryListOld: async () => { secondaryCalled = true; return []; },
      secondaryReadOld: async () => null,
    });
    expect(out.migrated).toBe(1);
    expect(secondaryCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claudette/agent && npx vitest run test/migrate.test.ts 2>&1 | tail -10
```

Expected: type errors or runtime failures because the secondary fields aren't on the interface.

- [ ] **Step 3: Extend `MigrateDeps` + add secondary fallback**

Replace the content of `agent/src/migrate.ts` with:

```ts
import type { OAuthCredential, AccountId } from "./types.js";

export interface MigrateDeps {
  listOld(): Promise<AccountId[]>;
  readOld(acctId: AccountId): Promise<OAuthCredential | null>;
  listNew(): Promise<AccountId[]>;
  writeNew(acctId: AccountId, cred: OAuthCredential): Promise<void>;
  log?(msg: string): void;
  // Optional fallback consulted only when the primary `listOld` returned
  // zero entries — used to chain across multiple historical service names.
  secondaryListOld?(): Promise<AccountId[]>;
  secondaryReadOld?(acctId: AccountId): Promise<OAuthCredential | null>;
}

export async function runMigrationOnce(deps: MigrateDeps): Promise<{ migrated: number; skipped: string[] }> {
  const log = deps.log ?? (() => {});
  const existing = await deps.listNew();
  if (existing.length > 0) {
    return { migrated: 0, skipped: [] };
  }

  let oldIds = await deps.listOld();
  let readOld = deps.readOld;

  if (oldIds.length === 0 && deps.secondaryListOld) {
    const secondary = await deps.secondaryListOld();
    if (secondary.length > 0) {
      oldIds = secondary;
      const secondaryRead = deps.secondaryReadOld;
      if (!secondaryRead) {
        // Shouldn't happen — types make both optional but they're paired.
        log(`[agent] migration: secondary source listed ${secondary.length} but no secondaryReadOld provided`);
        return { migrated: 0, skipped: [] };
      }
      readOld = secondaryRead;
    }
  }

  let migrated = 0;
  const skipped: string[] = [];
  for (const acctId of oldIds) {
    let cred: OAuthCredential | null = null;
    try { cred = await readOld(acctId); }
    catch { cred = null; }
    if (!cred) { skipped.push(acctId); continue; }
    await deps.writeNew(acctId, cred);
    migrated++;
  }
  log(`[agent] migrated ${migrated} credentials into "claudette-credentials"` +
    (skipped.length > 0 ? `; skipped ${skipped.join(", ")}` : ""));
  return { migrated, skipped };
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/claudette/agent && npx vitest run test/migrate.test.ts 2>&1 | tail -8
```

Expected: 5 tests pass (3 existing + 2 new).

- [ ] **Step 5: Type check**

```bash
cd ~/projects/claudette/agent && npx tsc --noEmit -p tsconfig.json; echo "tsc=$?"
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claudette
git add agent/src/migrate.ts agent/test/migrate.test.ts
git commit -m "feat(agent): migrate supports chained secondary source"
```

---

### Task 6: Keychain service rename + wire chained migration in entry point

**Files:**
- Modify: `agent/src/tokens.ts`
- Modify: `agent/src/index.ts`

**Interfaces:**
- Consumes: `runMigrationOnce` from Task 5; existing `KeychainStore`.
- Produces: agent reads/writes the `claudette-credentials` service; on startup, migrates from `Claude Code-credentials` first, then `claude-max-proxy-credentials` if the first is empty.

- [ ] **Step 1: Update the Keychain service constant in `tokens.ts`**

In `agent/src/tokens.ts`, locate:

```ts
const KEYCHAIN_SERVICE = "claudette-credentials";
```

Wait — verify the current state first:

```bash
grep "^const KEYCHAIN_SERVICE" ~/projects/claudette/agent/src/tokens.ts
```

If it says `"claude-max-proxy-credentials"`, change to `"claudette-credentials"`. If it already says `"claudette-credentials"`, no edit needed (it may have been pre-rotated by an earlier task).

- [ ] **Step 2: Update constants in `index.ts`**

In `agent/src/index.ts`, locate:

```ts
const NEW_SERVICE = "claudette-credentials";
const OLD_SERVICE = "Claude Code-credentials";
```

(Same check as above — verify current state with `grep -n "_SERVICE =" ~/projects/claudette/agent/src/index.ts`.)

Add a new constant for the secondary source. The block should read:

```ts
const NEW_SERVICE = "claudette-credentials";
const PRIMARY_OLD_SERVICE = "Claude Code-credentials";
const SECONDARY_OLD_SERVICE = "claude-max-proxy-credentials";
```

(Rename `OLD_SERVICE` → `PRIMARY_OLD_SERVICE` to make the chain explicit.)

- [ ] **Step 3: Update `migrateLegacyService()` to pass the secondary source**

In `agent/src/index.ts`, locate the existing `migrateLegacyService` function. Replace it with:

```ts
async function readOldServiceCredential(service: string, acctId: AccountId): Promise<OAuthCredential | null> {
  const r = await runSecurity(["find-generic-password", "-s", service, "-a", acctId, "-w"]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout.trim()) as { claudeAiOauth?: Record<string, unknown> } | null;
    const o = j?.claudeAiOauth;
    if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string" || typeof o.expiresAt !== "number") return null;
    const scopes = Array.isArray(o.scopes)
      ? (o.scopes as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      expiresAt: o.expiresAt,
      scopes,
    };
  } catch { return null; }
}

async function migrateLegacyService(): Promise<void> {
  await runMigrationOnce({
    listOld: () => listKeychainAccounts(PRIMARY_OLD_SERVICE),
    readOld: (acctId) => readOldServiceCredential(PRIMARY_OLD_SERVICE, acctId),
    listNew: () => listKeychainAccounts(NEW_SERVICE),
    writeNew: async (acctId, cred) => { await new KeychainStore(acctId).write(cred); },
    secondaryListOld: () => listKeychainAccounts(SECONDARY_OLD_SERVICE),
    secondaryReadOld: (acctId) => readOldServiceCredential(SECONDARY_OLD_SERVICE, acctId),
    log: (m) => console.log(m),
  });
}
```

Also update the empty-pool error message later in the file (find the line that mentions `'claudette-credentials'` or `'claude-max-proxy-credentials'`) so it consistently says `'claudette-credentials'`:

```ts
    console.error(`[agent] no Max-account Keychain entries discovered under service '${NEW_SERVICE}'. ` +
      "Run 'agent login --acct <email>' to capture one " +
      "(see docs/operations/capturing-multi-account-credentials.md).");
```

- [ ] **Step 4: Build + run all agent tests**

```bash
cd ~/projects/claudette/agent && npx tsc -p tsconfig.json && npx vitest run 2>&1 | tail -10
```

Expected: `tsc` exits 0; all suites pass (the existing 71 + 6 from Task 1 + 2 from Task 2 + 2 from Task 3 + 2 from Task 5 = 83 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claudette
git add agent/src/tokens.ts agent/src/index.ts
git commit -m "feat(agent): rename Keychain service to claudette-credentials with chained legacy migration"
```

---

### Task 7: Docs — purge `claude-max-proxy-credentials` mentions

**Files:**
- Modify: `docs/operations/capturing-multi-account-credentials.md`
- Modify: `README.md`

**Interfaces:**
- Produces: public docs reference `claudette-credentials` consistently; the historical name appears only in migration-context explanations.

- [ ] **Step 1: Update the ops doc**

In `docs/operations/capturing-multi-account-credentials.md`, replace every occurrence of `claude-max-proxy-credentials` with `claudette-credentials`, EXCEPT in any sentence that explicitly explains the migration chain.

Run:

```bash
sed -i '' 's/claude-max-proxy-credentials/claudette-credentials/g' ~/projects/claudette/docs/operations/capturing-multi-account-credentials.md
```

Then open the file and verify there's a paragraph about migration. If absent, append the following section just before "## Disabling an account temporarily":

```markdown
## Where credentials are stored

claudette writes its OAuth credentials to the macOS Keychain under
service `claudette-credentials`. The agent never reads from
`Claude Code-credentials` (the Claude Code CLI's own credential
location) at runtime, only during a one-shot migration on first start.

If you previously ran the `claude-max-proxy`-era build, your credentials
were stored under `claude-max-proxy-credentials`. The agent migrates
those entries automatically on first start of this build: it tries
`Claude Code-credentials` first, then falls back to
`claude-max-proxy-credentials`. After migration the two old services
keep their entries (no destructive delete) but are no longer read.
```

- [ ] **Step 2: Update `README.md`**

```bash
sed -i '' 's/claude-max-proxy-credentials/claudette-credentials/g' ~/projects/claudette/README.md
```

- [ ] **Step 3: Verify zero stale mentions in tracked files**

```bash
cd ~/projects/claudette && git grep -n "claude-max-proxy-credentials" -- ':!*lock*'
```

Expected: only the deliberate mentions inside the migration-context paragraph(s).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/claudette
git add docs/operations/capturing-multi-account-credentials.md README.md
git commit -m "docs: rename Keychain service to claudette-credentials in docs"
```

---

### Task 8: Build + full test pass

**Files:** none (verification only)

**Interfaces:**
- Verifies: 83 agent tests + 32 worker tests = 115 tests pass, both packages typecheck clean.

- [ ] **Step 1: Clean install**

```bash
cd ~/projects/claudette && rm -rf node_modules agent/node_modules worker/node_modules && npm install 2>&1 | tail -3
```

- [ ] **Step 2: Build agent**

```bash
cd ~/projects/claudette/agent && npm run build 2>&1 | tail -3 && ls dist/
```

Expected: exit 0; dist/ has admin.js, index.js, login.js, migrate.js, oauth.js, pool.js, server.js, tier.js, tokens.js, types.js, upstream.js, watcher.js.

- [ ] **Step 3: Full test suite**

```bash
cd ~/projects/claudette && npm test 2>&1 | tail -15; cd agent && npx vitest run 2>&1 | tail -8
```

Expected: worker 32 pass, agent 83 pass.

- [ ] **Step 4: Commit any incidental changes (e.g., package-lock churn)**

```bash
cd ~/projects/claudette && git status --short
```

If `git status` shows changes, commit them; otherwise skip:

```bash
git add -A && git -c user.email=bobjansen@pm.me -c user.name="bbjansen" commit -q -m "chore: refresh package-lock after install"
```

---

### Task 9: Stand up the green Cloudflare stack (Tunnel + DNS + Access app)

**Files:** none (Cloudflare API + macOS dot-files)

**Interfaces:**
- Produces: new Tunnel `claudette` (with UUID), DNS CNAME `claudette-agent.bobjansen.dev`, new CF Access application + service token guarding the new hostname.

- [ ] **Step 1: Create the new Tunnel**

```bash
TOKEN=$(cat ~/.claude-max-proxy.cf)
AID=64f75ad3008e37e68b03ebbedefc89ed
SECRET=$(openssl rand -base64 32)
RESP=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$AID/cfd_tunnel" \
  -d "{\"name\":\"claudette\",\"tunnel_secret\":\"$SECRET\",\"config_src\":\"local\"}")
echo "$RESP" | python3 -m json.tool | head -10
NEW_UUID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['id'])")
echo "NEW_UUID=$NEW_UUID"
python3 -c "import json,os;cred={'AccountTag':'$AID','TunnelID':'$NEW_UUID','TunnelName':'claudette','TunnelSecret':'$SECRET'};open(os.path.expanduser(f'~/.cloudflared/{cred[chr(34)+chr(84)+chr(117)+chr(110)+chr(110)+chr(101)+chr(108)+chr(73)+chr(68)+chr(34)]}.json'),'w').write(json.dumps(cred))"
ls -la ~/.cloudflared/$NEW_UUID.json
```

Expected: `"success": true`, NEW_UUID printed, credentials JSON saved.

(Alternate one-liner for the cred-file write that avoids the chr() escape gymnastics — use this if the above looks ugly):

```bash
cat > ~/.cloudflared/$NEW_UUID.json <<EOF
{"AccountTag":"$AID","TunnelID":"$NEW_UUID","TunnelName":"claudette","TunnelSecret":"$SECRET"}
EOF
```

- [ ] **Step 2: Add DNS CNAME for the new hostname**

```bash
ZID=5ebdfe4a74e9d477a0bb7250ab2376e7  # bobjansen.dev zone ID; re-fetch if uncertain
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records" \
  -d "{\"type\":\"CNAME\",\"name\":\"claudette-agent\",\"content\":\"$NEW_UUID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1,\"comment\":\"claudette tunnel\"}" \
  | python3 -m json.tool | head -10
```

Expected: `"success": true` with the new record ID.

If the zone ID is uncertain, recover it with:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/zones?name=bobjansen.dev" | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['id'])"
```

- [ ] **Step 3: Create the new CF Access application**

Operator step — done via the Cloudflare Zero Trust dashboard since the
Access API surface is sprawling. Walkthrough:

1. https://one.dash.cloudflare.com/ → Access → Applications → Add an
   application → Self-hosted.
2. Application name: `claudette-tunnel`.
3. Application domain: `claudette-agent.bobjansen.dev`.
4. Identity providers: leave defaults; this is service-to-service.
5. Policy: Add → Service Auth → name `worker-only` → Selector: Service Token → Create new service token `claudette-worker`. Save the **Client ID** and **Client Secret** — needed in Task 10.
6. Save the application; copy the **Application Audience (AUD) Tag** from the application overview page — also needed in Task 10.

Save the three values temporarily in three files:

```bash
echo "<AUD>"            > /tmp/claudette.aud
echo "<CLIENT_ID>"      > /tmp/claudette.cid
echo "<CLIENT_SECRET>"  > /tmp/claudette.csec
chmod 600 /tmp/claudette.aud /tmp/claudette.cid /tmp/claudette.csec
```

These get consumed in Task 10 step 4 and then deleted.

- [ ] **Step 4: Boot out the old cloudflared launchd job + install the new one**

```bash
launchctl bootout "gui/$(id -u)/com.bobjansen.cloudflared-claude" 2>&1 || true
sleep 1
pgrep -lf cloudflared | head
```

Expected: no cloudflared process running.

Edit `~/.cloudflared/config.yml` to point at the new tunnel:

```yaml
tunnel: <NEW_UUID>
credentials-file: /Users/bob.jansen/.cloudflared/<NEW_UUID>.json
ingress:
  - hostname: claudette-agent.bobjansen.dev
    service: http://localhost:8787
  - service: http_status:404
```

Install the new plist:

```bash
sed "s|/Users/USERNAME|$HOME|g" ~/projects/claudette/scripts/dev.claudette.cloudflared.plist \
  > ~/Library/LaunchAgents/dev.claudette.cloudflared.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.claudette.cloudflared.plist
sleep 6
tail -15 ~/Library/Logs/cloudflared-claudette.out.log
```

Expected: `Registered tunnel connection` lines in the log.

- [ ] **Step 5: Verify the agent is still reachable through the new chain (without any Access yet, just through the tunnel raw)**

```bash
curl -sS -X POST "https://claudette-agent.bobjansen.dev/v1/messages" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}' \
  | head -c 200
```

The tunnel hostname is now served by Cloudflare with the Access policy
in front. Without a valid service token this should return `302` (Access
login redirect) or `403`. NOT 200. That's the check:

```bash
curl -i -sS -o /dev/null -w "no-auth status: %{http_code}\n" -X POST "https://claudette-agent.bobjansen.dev/v1/messages" -H "content-type: application/json" -d '{}'
```

Expected: 302 or 403.

- [ ] **Step 6: Verify the new tunnel hostname works WITH the service token**

```bash
CID=$(cat /tmp/claudette.cid)
CSEC=$(cat /tmp/claudette.csec)
curl -sS -X POST "https://claudette-agent.bobjansen.dev/v1/messages" \
  -H "cf-access-client-id: $CID" \
  -H "cf-access-client-secret: $CSEC" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}' \
  | head -c 200
```

Expected: a `"type":"message"` response.

---

### Task 10: Deploy the new (green) Worker

**Files:**
- Modify: `worker/wrangler.jsonc` (in working tree only — re-verified at the end)
- Create: `~/.claudette.key`

**Interfaces:**
- Produces: Worker `claudette` deployed at `https://claudette.bobjansen.workers.dev` with rotated PROXY_KEY and service-token / AUD secrets pointing at the new Access app.

- [ ] **Step 1: Generate the new PROXY_KEY**

```bash
PROXY_KEY=$(openssl rand -hex 32)
echo -n "$PROXY_KEY" > ~/.claudette.key
chmod 600 ~/.claudette.key
ls -la ~/.claudette.key
```

- [ ] **Step 2: Update `worker/wrangler.jsonc` `TUNNEL_HOSTNAME` to the new hostname**

In `~/projects/claudette/worker/wrangler.jsonc`, replace the line:

```jsonc
    "TUNNEL_HOSTNAME": "claudette-agent.<your-zone>",
```

with:

```jsonc
    "TUNNEL_HOSTNAME": "claudette-agent.bobjansen.dev",
```

Also set `ACCESS_TEAM_DOMAIN` — recover it (or leave the placeholder; we
only need it if using JWT auth, not service-token):

```jsonc
    "ACCESS_TEAM_DOMAIN": "REPLACE_WITH_TEAM.cloudflareaccess.com"
```

(For service-token-only operation, `ACCESS_TEAM_DOMAIN` is unused by
this path; the Worker only uses it when validating inbound JWT, which
the operator does via PROXY_KEY. Leave the placeholder.)

- [ ] **Step 3: Deploy the new Worker**

```bash
cd ~/projects/claudette/worker
CLOUDFLARE_API_TOKEN=$(cat ~/.claude-max-proxy.cf) \
CLOUDFLARE_ACCOUNT_ID=64f75ad3008e37e68b03ebbedefc89ed \
  npx wrangler deploy 2>&1 | tail -10
```

Expected: `Uploaded claudette` and `Deployed claudette triggers` printed; URL `https://claudette.<your-workers-subdomain>.workers.dev` printed. Note the URL.

- [ ] **Step 4: Push the secrets to the new Worker**

```bash
cd ~/projects/claudette/worker
TOKEN=$(cat ~/.claude-max-proxy.cf) AID=64f75ad3008e37e68b03ebbedefc89ed
PROXY_KEY=$(cat ~/.claudette.key)
AUD=$(cat /tmp/claudette.aud)
CID=$(cat /tmp/claudette.cid)
CSEC=$(cat /tmp/claudette.csec)

CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=$AID \
  bash -c "echo -n '$PROXY_KEY' | npx wrangler secret put PROXY_KEY" 2>&1 | tail -3
CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=$AID \
  bash -c "echo -n '$AUD' | npx wrangler secret put ACCESS_AUD" 2>&1 | tail -3
CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=$AID \
  bash -c "echo -n '$CID' | npx wrangler secret put TUNNEL_ACCESS_CLIENT_ID" 2>&1 | tail -3
CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=$AID \
  bash -c "echo -n '$CSEC' | npx wrangler secret put TUNNEL_ACCESS_CLIENT_SECRET" 2>&1 | tail -3
```

Expected: four `✨ Success! Uploaded secret <NAME>` lines.

- [ ] **Step 5: Smoke test the new Worker end-to-end**

```bash
PROXY_KEY=$(cat ~/.claudette.key)
echo "--- via Authorization: Bearer ---"
curl -sS -X POST https://claudette.bobjansen.workers.dev/v1/messages \
  -H "authorization: Bearer $PROXY_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"PONG"}]}' \
  | head -c 300; echo
echo "--- via X-Account-Hint ---"
curl -sS -X POST https://claudette.bobjansen.workers.dev/v1/messages \
  -H "authorization: Bearer $PROXY_KEY" \
  -H "content-type: application/json" \
  -H "x-account-hint: bob.jansen@pm.me" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"PONG"}]}' \
  | head -c 300; echo
echo "--- agent log (last 3) ---"
tail -3 ~/Library/Logs/claudette.out.log
```

Expected: both calls return `"type":"message"`; the second log line shows `acctId: 'bob.jansen@pm.me'`.

- [ ] **Step 6: Clean up temporary secret files**

```bash
shred -u /tmp/claudette.aud /tmp/claudette.cid /tmp/claudette.csec 2>/dev/null || rm -f /tmp/claudette.aud /tmp/claudette.cid /tmp/claudette.csec
ls /tmp/claudette.* 2>&1 || echo "(gone)"
```

---

### Task 11: Switch Claude Code to the new Worker via settings.json

**Files:**
- Create / Modify: `~/.claude/settings.json`
- Backup: `~/.claude/settings.json.pre-claudette.bak` (if file exists)

**Interfaces:**
- Produces: Claude Code on this Mac uses the new Worker URL with X-Account-Hint pinned to a chosen account.

- [ ] **Step 1: Backup current settings.json (if it exists)**

```bash
if [ -f ~/.claude/settings.json ]; then
  cp ~/.claude/settings.json ~/.claude/settings.json.pre-claudette.bak
  echo "backed up"
  cat ~/.claude/settings.json
else
  echo "no existing settings.json"
fi
```

- [ ] **Step 2: Write the new settings.json**

```bash
PROXY_KEY=$(cat ~/.claudette.key)
python3 - <<EOF
import json, os, pathlib
settings_path = pathlib.Path.home() / ".claude" / "settings.json"
existing = {}
if settings_path.exists():
    try: existing = json.loads(settings_path.read_text())
    except Exception: existing = {}
env_block = existing.get("env", {})
env_block["ANTHROPIC_BASE_URL"]        = "https://claudette.bobjansen.workers.dev"
env_block["ANTHROPIC_API_KEY"]         = "$PROXY_KEY"
env_block["ANTHROPIC_CUSTOM_HEADERS"]  = "X-Account-Hint: bob.jansen@pm.me"
existing["env"] = env_block
settings_path.parent.mkdir(parents=True, exist_ok=True)
settings_path.write_text(json.dumps(existing, indent=2))
print("wrote", settings_path)
EOF
cat ~/.claude/settings.json
```

Replace `bob.jansen@pm.me` with whichever account you want Claude Code
pinned to.

- [ ] **Step 3: Verify Claude Code picks up the change**

Quit any running Claude Code (any open terminal session). Open a fresh
terminal session and run:

```bash
claude --version 2>&1 | head -3
```

Then start a new `claude` session in a separate window, run a brief
message in it, and back in the original terminal:

```bash
curl -sS http://127.0.0.1:8787/v1/admin/accounts | python3 -c "import sys,json;d=json.load(sys.stdin);[print(f\"  {a['acct_id']:30} last_used_ms={a['last_used_ms']}\") for a in d['accounts']]"
```

Expected: only `bob.jansen@pm.me` (or whatever account you pinned)
shows a non-null `last_used_ms` after the Claude Code session ran.

If Claude Code didn't honor `ANTHROPIC_CUSTOM_HEADERS`, all accounts
will get some traffic over time. In that case use the wrapper fallback:

```bash
cat > ~/.local/bin/claude-pinned <<'WRAP'
#!/usr/bin/env bash
ACCT="${CLAUDETTE_PIN:-bob.jansen@pm.me}"
KEY="$(cat "$HOME/.claudette.key")"
exec /opt/homebrew/bin/claude \
  --settings "{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://claudette.bobjansen.workers.dev\",\"ANTHROPIC_API_KEY\":\"$KEY\",\"ANTHROPIC_CUSTOM_HEADERS\":\"X-Account-Hint: $ACCT\"}}" "$@"
WRAP
chmod +x ~/.local/bin/claude-pinned
```

Then use `claude-pinned` instead of `claude` for sessions you want pinned.

---

### Task 12: Tear down the blue (old) Cloudflare stack

**Files:** none (Cloudflare API + local dot-files)

**Interfaces:**
- Produces: old resources removed; only `claudette.*` remains.

- [ ] **Step 1: Delete the old Worker**

```bash
cd ~/projects/claudette/worker
CLOUDFLARE_API_TOKEN=$(cat ~/.claude-max-proxy.cf) CLOUDFLARE_ACCOUNT_ID=64f75ad3008e37e68b03ebbedefc89ed \
  npx wrangler delete --name claude-max-proxy 2>&1 | tail -5
```

Confirm the prompt with `y` if interactive. Expected: `Deleted Worker claude-max-proxy`.

- [ ] **Step 2: List + delete the old DNS CNAME**

```bash
TOKEN=$(cat ~/.claude-max-proxy.cf)
ZID=5ebdfe4a74e9d477a0bb7250ab2376e7
RESP=$(curl -sS -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?name=claude-agent.bobjansen.dev")
OLD_DNS_ID=$(echo "$RESP" | python3 -c "import sys,json;r=json.load(sys.stdin)['result'];print(r[0]['id'] if r else '')")
echo "OLD_DNS_ID=$OLD_DNS_ID"
[ -n "$OLD_DNS_ID" ] && curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records/$OLD_DNS_ID" | head -c 100 || echo "(no record found)"
```

Expected: `"success": true` with deleted id.

- [ ] **Step 3: Delete the old Tunnel**

```bash
TOKEN=$(cat ~/.claude-max-proxy.cf)
AID=64f75ad3008e37e68b03ebbedefc89ed
RESP=$(curl -sS -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/accounts/$AID/cfd_tunnel?name=claude-max-proxy&is_deleted=false")
OLD_TUNNEL_UUID=$(echo "$RESP" | python3 -c "import sys,json;r=json.load(sys.stdin)['result'];print(r[0]['id'] if r else '')")
echo "OLD_TUNNEL_UUID=$OLD_TUNNEL_UUID"
[ -n "$OLD_TUNNEL_UUID" ] && curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/accounts/$AID/cfd_tunnel/$OLD_TUNNEL_UUID" | head -c 200 || echo "(no tunnel found)"
```

Expected: `"success": true`.

- [ ] **Step 4: Delete the old credentials file from the local cloudflared dir**

```bash
[ -n "$OLD_TUNNEL_UUID" ] && rm -fv ~/.cloudflared/$OLD_TUNNEL_UUID.json || echo "(no file)"
ls ~/.cloudflared/*.json 2>&1
```

Expected: only `~/.cloudflared/<NEW_UUID>.json` remains (the active tunnel).

- [ ] **Step 5: Delete the old CF Access app + service token** (operator step)

In https://one.dash.cloudflare.com/:
1. Access → Applications → find the old `claude-max-proxy-tunnel` (or similar) → ⋯ → Delete.
2. Settings → Service tokens → find `claude-max-proxy-worker` (or whatever was named) → Revoke.

- [ ] **Step 6: Delete the old PROXY_KEY file**

```bash
rm -fv ~/.claude-max-proxy.key
ls ~/.claudette.key
```

Expected: old gone; new present.

- [ ] **Step 7: Final live verification**

```bash
PROXY_KEY=$(cat ~/.claudette.key)
echo "--- new URL still works ---"
curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://claudette.bobjansen.workers.dev/v1/messages \
  -H "authorization: Bearer $PROXY_KEY" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}'
echo "--- old URL is gone ---"
curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://claude-max-proxy.bobjansen.workers.dev/v1/messages \
  -H "authorization: Bearer $PROXY_KEY" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}'
echo "--- pool snapshot ---"
curl -sS http://127.0.0.1:8787/v1/admin/accounts | python3 -c "import sys,json;d=json.load(sys.stdin);[print(f'  {a[\"acct_id\"]}') for a in d['accounts']]"
```

Expected: new URL → `200`; old URL → `404` or `530`; pool shows all 4 accounts.

---

### Task 13: Push branch + open PR

**Files:** none

**Interfaces:**
- Produces: pushed branch + PR URL printed.

- [ ] **Step 1: Push the branch**

```bash
cd ~/projects/claudette && git push -u origin feature/CMP-004-claudette-completion 2>&1 | tail -3
```

Expected: PR-create URL printed by GitHub.

- [ ] **Step 2: Open the PR via `gh` (or via the printed URL)**

```bash
cd ~/projects/claudette && gh pr create --title "Keychain rename + Claude Code routing + Cloudflare live rename" --body "$(cat <<'EOF'
## Summary

- Rename Keychain service `claude-max-proxy-credentials` → `claudette-credentials` with chained migration from both `Claude Code-credentials` (primary) and `claude-max-proxy-credentials` (secondary fallback).
- Add per-session account pinning for Claude Code: agent's `AccountPool.pickToken` honors an optional `hint`; Worker forwards `x-account-hint` header through the Tunnel; agent's server extracts the header and threads it to upstream.
- Blue/green rename of the live Cloudflare deployment: Worker `claude-max-proxy` → `claudette`, Tunnel hostname `claude-agent.bobjansen.dev` → `claudette-agent.bobjansen.dev`, PROXY_KEY rotated, old resources deleted after verification.

## Test plan

- [x] Agent: 83 vitest tests pass
- [x] Worker: 32 vitest tests pass
- [x] Live: new Worker URL serves 200; old URL gone
- [x] Live: Claude Code session with pin sticks to one account in admin snapshot
- [x] Live: agent's KeychainWatcher continues to find all 4 accounts under the new service name

Closes [CMP-004]
EOF
)" 2>&1 | tail -3
```

Expected: PR URL printed.

---

## Spec coverage check

- Goal 1 (Keychain rename + chained migration) — Tasks 5, 6, 7.
- Goal 2 (Claude Code routing with sticky pin) — Tasks 1, 2, 3, 4, 11.
- Goal 3 (Live Cloudflare rename) — Tasks 9, 10, 12.
- Goal 4 (Blue/green with overlap, no destructive cuts) — Phases A (Tasks 9, 10), B (Task 11), C (Task 12). Smoke gates at end of A (Task 10 Step 5) and B (Task 11 Step 3).
- Architecture diagram — covered by Tasks 4 (Worker forwarding), 9 (Tunnel + DNS + Access), 10 (Worker secrets), 11 (Claude Code env), 12 (cleanup).
- Components — Keychain (Task 6), Claude Code routing (Tasks 1–4, 11), Cloudflare (Tasks 9, 10, 12).
- Data flow — exercised in Task 10 Step 5 (smoke test) and Task 11 Step 3 (Claude Code).
- Error handling table — all rows covered:
  - Hint cooled/disabled/unknown: Task 1 tests.
  - Migration primary populated and secondary populated: Task 5 second test ("does NOT consult the secondary source").
  - Worker fails to forward x-account-hint: Task 4 test.
  - Old tear-down failure: Task 12 idempotent (operator retry).
  - Access app misconfigured: caught by Task 9 step 5 / Task 10 step 5 smoke.
  - `ANTHROPIC_CUSTOM_HEADERS` ignored: Task 11 step 3 fallback wrapper.
- Testing requirement — Tasks 1–5 each add their own tests; Task 8 verifies the full suite.
- Project layout (delta) — every modified file appears in some task.
- Configuration & secrets — Task 10 Step 1 (PROXY_KEY), Task 9 Step 3 (CF Access secrets), Task 11 Step 2 (settings.json).
- Risks — covered: `ANTHROPIC_CUSTOM_HEADERS` (Task 11 fallback), Keychain ACL prompt (Task 6 surfaces it inline), old URL deletion (Task 12 idempotent), API token scopes (we use the same token throughout; dashboard fallback in Task 9 Step 3), PROXY_KEY rotation breaking nram (operator updates separately; out of this PR's scope).
- Tear-down (Phase C) — Task 12 step-by-step.
- Live verification gates — Task 10 Step 5, Task 11 Step 3, Task 12 Step 7.

No gaps.
