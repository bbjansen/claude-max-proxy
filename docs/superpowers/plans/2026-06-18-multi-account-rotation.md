# Multi-account rotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an N-account rotating pool to the proxy agent that load-balances across all Max accounts discovered in macOS Keychain, fails over on `429 rate_limit_error` with per-(account, model-tier) cooldown, picks up external Claude Code refreshes via a 5s watcher tick, and exposes an admin HTTP surface for snapshot/disable/enable.

**Architecture:** Existing per-account `TokenManager` is unchanged; new `AccountPool` owns N of them plus an in-memory cooldown matrix. A `KeychainWatcher` polls every 5s to reconcile the roster and adopt external credential rotations. `upstream.ts` switches to selector-driven `pickToken` with up to 3 attempts on 429. `server.ts` gains admin routes.

**Tech Stack:** TypeScript / Node 20+, existing `node:http`, existing `proper-lockfile`, `vitest`. No new runtime deps. Tests use injected fakes — no real Keychain in CI.

## Global Constraints

- Branch off `main` (per user CLAUDE.md feature-branch rule).
- Exact dependency versions in `package.json` (no `^` / `~`).
- Default cooldown when `retry-after` header is missing: `5 * 60 * 1000` ms.
- Refresh threshold (`60_000` ms), file lock path (`~/.claude/.proxy-refresh.lock`), and OAuth headers stay the same as the single-account agent.
- `CLAUDE_MAX_ACCOUNTS` env var, when set, is a comma-separated allowlist of `acctId`s the pool may use. Unset = auto-discover all entries.
- Keychain service name `"Claude Code-credentials"` is unchanged.
- All new files live under `agent/src/` or `agent/test/`. Operational guide under `docs/operations/`. Capture helper under `scripts/`.
- Commit messages are conventional, no co-author, no AI references (per user CLAUDE.md).

---

### Task 1: Feature branch, ModelTier type, tier helpers

**Files:**
- Modify: `~/projects/claude-max-proxy/agent/src/types.ts`
- Create: `~/projects/claude-max-proxy/agent/src/tier.ts`
- Create: `~/projects/claude-max-proxy/agent/test/tier.test.ts`

**Interfaces:**
- Produces:
  - `AccountId = string`
  - `ModelTier = "opus" | "sonnet" | "haiku" | "other"`
  - `modelTierOf(model: string | undefined | null): ModelTier`
  - `retryAfterMs(response: Response, nowMs: number, defaultMs?: number): number` — returns the cooldown delta in ms (header value × 1000 for integer, `date-now` for HTTP-date, `defaultMs` (5 minutes) when missing or malformed), clamped to `[0, 60*60*1000]`.

- [ ] **Step 1: Branch from main**

```bash
cd ~/projects/claude-max-proxy
git checkout main
git pull --ff-only 2>/dev/null || true
git checkout -b feature/CMP-002-multi-account-rotation
```

Expected: `Switched to a new branch 'feature/CMP-002-multi-account-rotation'`.

- [ ] **Step 2: Extend types**

Append to `~/projects/claude-max-proxy/agent/src/types.ts`:

```ts
export type AccountId = string;
export type ModelTier = "opus" | "sonnet" | "haiku" | "other";
```

- [ ] **Step 3: Write the failing tests**

`~/projects/claude-max-proxy/agent/test/tier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { modelTierOf, retryAfterMs } from "../src/tier.js";

describe("modelTierOf", () => {
  it("maps known model families", () => {
    expect(modelTierOf("claude-opus-4-8")).toBe("opus");
    expect(modelTierOf("claude-opus-4-7-20251001")).toBe("opus");
    expect(modelTierOf("claude-sonnet-4-6")).toBe("sonnet");
    expect(modelTierOf("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("falls through to 'other' for unknown / missing model", () => {
    expect(modelTierOf("gpt-4")).toBe("other");
    expect(modelTierOf("")).toBe("other");
    expect(modelTierOf(undefined)).toBe("other");
    expect(modelTierOf(null)).toBe("other");
  });
});

describe("retryAfterMs", () => {
  const now = 1_700_000_000_000;
  const fiveMin = 5 * 60_000;
  const oneHour = 60 * 60_000;

  function res(headers: Record<string, string>): Response {
    return new Response(null, { status: 429, headers });
  }

  it("parses integer seconds", () => {
    expect(retryAfterMs(res({ "retry-after": "30" }), now)).toBe(30_000);
  });

  it("parses HTTP-date relative to now", () => {
    const future = new Date(now + 90_000).toUTCString();
    const got = retryAfterMs(res({ "retry-after": future }), now);
    // Allow ±1s tolerance for date precision.
    expect(Math.abs(got - 90_000)).toBeLessThanOrEqual(1000);
  });

  it("clamps to 1 hour upper bound", () => {
    expect(retryAfterMs(res({ "retry-after": "999999" }), now)).toBe(oneHour);
  });

  it("clamps negative deltas (date already passed) to 0", () => {
    const past = new Date(now - 10_000).toUTCString();
    expect(retryAfterMs(res({ "retry-after": past }), now)).toBe(0);
  });

  it("falls back to default when header is missing", () => {
    expect(retryAfterMs(res({}), now)).toBe(fiveMin);
  });

  it("falls back to default when header is malformed", () => {
    expect(retryAfterMs(res({ "retry-after": "garbage!!" }), now)).toBe(fiveMin);
  });

  it("honors the explicit default override", () => {
    expect(retryAfterMs(res({}), now, 10_000)).toBe(10_000);
  });
});
```

- [ ] **Step 4: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/tier.test.ts
```

Expected: file-not-found error for `../src/tier.js`.

- [ ] **Step 5: Implement**

`~/projects/claude-max-proxy/agent/src/tier.ts`:

```ts
import type { ModelTier } from "./types.js";

const FIVE_MIN_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export function modelTierOf(model: string | undefined | null): ModelTier {
  if (!model) return "other";
  if (model.startsWith("claude-opus-")) return "opus";
  if (model.startsWith("claude-sonnet-")) return "sonnet";
  if (model.startsWith("claude-haiku-")) return "haiku";
  return "other";
}

export function retryAfterMs(response: Response, nowMs: number, defaultMs = FIVE_MIN_MS): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return defaultMs;
  const trimmed = raw.trim();
  // Integer seconds form.
  if (/^\d+$/.test(trimmed)) {
    return clamp(Number(trimmed) * 1000);
  }
  // HTTP-date form.
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return clamp(parsed - nowMs);
  }
  return defaultMs;
}

function clamp(ms: number): number {
  if (ms < 0) return 0;
  if (ms > ONE_HOUR_MS) return ONE_HOUR_MS;
  return ms;
}
```

- [ ] **Step 6: Run tests and verify pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/tier.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 7: Type check**

```bash
cd ~/projects/claude-max-proxy/agent && npx tsc --noEmit -p tsconfig.json
```

Expected: exit code 0.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/types.ts agent/src/tier.ts agent/test/tier.test.ts
git commit -m "feat(agent): ModelTier + tier helpers (modelTierOf, retryAfterMs)"
```

---

### Task 2: TokenManager.adoptExternalCredential

**Files:**
- Modify: `~/projects/claude-max-proxy/agent/src/tokens.ts`
- Modify: `~/projects/claude-max-proxy/agent/test/tokens.test.ts`

**Interfaces:**
- Consumes: existing `TokenManager`, `OAuthCredential`.
- Produces: `TokenManager.adoptExternalCredential(cred: OAuthCredential): void` — atomically replaces the in-memory cache without acquiring the file lock and without triggering an upstream refresh.

- [ ] **Step 1: Write the failing test**

Append to `~/projects/claude-max-proxy/agent/test/tokens.test.ts` *(immediately before the file's closing `});` of the `describe("TokenManager", ...)` block)*:

```ts
  it("adoptExternalCredential swaps the cache without calling the refresher", async () => {
    const cred = { ...baseCred, expiresAt: now + 10 * 60_000 };
    const newer: OAuthCredential = {
      accessToken: "sk-ant-oat01-EXTERNAL",
      refreshToken: "sk-ant-ort01-EXTERNAL",
      expiresAt: now + 8 * 3_600_000,
      scopes: ["user:inference"],
    };
    const { store } = makeStore(cred);
    const refresher = makeRefresher(newer);
    const tm = new TokenManager(store, refresher, noopLock(), clock);

    await tm.getAccessToken(); // warm cache to `cred`
    tm.adoptExternalCredential(newer);

    expect(await tm.getAccessToken()).toBe("sk-ant-oat01-EXTERNAL");
    expect(refresher.refresh).not.toHaveBeenCalled();
    // The store read count must not increment from the adopt call.
    expect(store.read).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Watch it fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/tokens.test.ts
```

Expected: `tm.adoptExternalCredential is not a function`.

- [ ] **Step 3: Implement**

In `~/projects/claude-max-proxy/agent/src/tokens.ts`, inside the `TokenManager` class right after the `forceRefresh()` method:

```ts
  /**
   * Replace the in-memory cached credential without touching the store or
   * the refresher. Used by KeychainWatcher when a peer process (interactive
   * Claude Code) rotates the token and writes a newer credential to Keychain.
   */
  adoptExternalCredential(cred: OAuthCredential): void {
    this.cached = cred;
  }
```

- [ ] **Step 4: Tests pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/tokens.test.ts
```

Expected: 8 tests pass (7 existing + 1 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/tokens.ts agent/test/tokens.test.ts
git commit -m "feat(agent): TokenManager.adoptExternalCredential for external rotations"
```

---

### Task 3: AccountPool — round-robin + cooldown + exclude + fallback

**Files:**
- Create: `~/projects/claude-max-proxy/agent/src/pool.ts`
- Create: `~/projects/claude-max-proxy/agent/test/pool.test.ts`

**Interfaces:**
- Consumes: `TokenManager` (only its `getAccessToken(): Promise<string>` method), `AccountId`, `ModelTier`.
- Produces:
  - `class AccountPool`:
    - `constructor(entries: Array<{ acctId: AccountId; manager: TokenManager }>, opts?: { clock?: () => number })`
    - `accounts(): AccountId[]` — insertion order
    - `pickToken(tier: ModelTier, exclude?: AccountId[]): Promise<{ acctId: AccountId; token: string }>`
    - `markCooldown(acctId: AccountId, tier: ModelTier, untilMs: number): void`

- [ ] **Step 1: Write the failing tests**

`~/projects/claude-max-proxy/agent/test/pool.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AccountPool } from "../src/pool.js";
import type { TokenManager } from "../src/tokens.js";

function fakeManager(token: string): TokenManager {
  return {
    async getAccessToken() { return token; },
    async forceRefresh() { return token; },
    adoptExternalCredential() {},
  } as unknown as TokenManager;
}

describe("AccountPool", () => {
  const NOW = 1_700_000_000_000;
  const clock = () => NOW;

  const A = { acctId: "a@x", manager: fakeManager("tok-A") };
  const B = { acctId: "b@y", manager: fakeManager("tok-B") };
  const C = { acctId: "c@z", manager: fakeManager("tok-C") };

  it("round-robins across accounts when no cooldown applies", async () => {
    const p = new AccountPool([A, B, C], { clock });
    const first  = await p.pickToken("opus");
    const second = await p.pickToken("opus");
    const third  = await p.pickToken("opus");
    const fourth = await p.pickToken("opus");
    expect([first.acctId, second.acctId, third.acctId, fourth.acctId])
      .toEqual(["a@x", "b@y", "c@z", "a@x"]);
  });

  it("skips an account whose cooldown for the requested tier is active", async () => {
    const p = new AccountPool([A, B, C], { clock });
    p.markCooldown("a@x", "opus", NOW + 60_000);
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push((await p.pickToken("opus")).acctId);
    expect(picks).toEqual(["b@y", "c@z", "b@y", "c@z"]);
  });

  it("does not skip account on a tier with no active cooldown", async () => {
    const p = new AccountPool([A, B], { clock });
    p.markCooldown("a@x", "opus", NOW + 60_000);
    const haikuPick = await p.pickToken("haiku");
    expect(haikuPick.acctId).toBe("a@x");
  });

  it("respects the exclude list (failover excludes the already-failed account)", async () => {
    const p = new AccountPool([A, B, C], { clock });
    const pick = await p.pickToken("opus", ["a@x"]);
    expect(pick.acctId).toBe("b@y");
  });

  it("falls back to the soonest-expiring account when every candidate is cooled", async () => {
    const p = new AccountPool([A, B, C], { clock });
    p.markCooldown("a@x", "opus", NOW + 30 * 60_000);
    p.markCooldown("b@y", "opus", NOW +  5 * 60_000); // soonest
    p.markCooldown("c@z", "opus", NOW + 15 * 60_000);
    const pick = await p.pickToken("opus");
    expect(pick.acctId).toBe("b@y");
  });

  it("never picks an excluded account, even in the all-cooled fallback", async () => {
    const p = new AccountPool([A, B], { clock });
    p.markCooldown("a@x", "opus", NOW +  1 * 60_000); // soonest
    p.markCooldown("b@y", "opus", NOW + 30 * 60_000);
    const pick = await p.pickToken("opus", ["a@x"]);
    expect(pick.acctId).toBe("b@y");
  });

  it("throws when the pool has no eligible accounts after applying exclude", async () => {
    const p = new AccountPool([A], { clock });
    await expect(p.pickToken("opus", ["a@x"])).rejects.toThrow(/no eligible account/i);
  });

  it("throws when the pool is empty", async () => {
    const p = new AccountPool([], { clock });
    await expect(p.pickToken("opus")).rejects.toThrow(/empty/i);
  });

  it("accounts() returns insertion order", () => {
    const p = new AccountPool([A, B, C], { clock });
    expect(p.accounts()).toEqual(["a@x", "b@y", "c@z"]);
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/pool.test.ts
```

Expected: file-not-found.

- [ ] **Step 3: Implement**

`~/projects/claude-max-proxy/agent/src/pool.ts`:

```ts
import type { AccountId, ModelTier } from "./types.js";
import type { TokenManager } from "./tokens.js";

const TIERS: ModelTier[] = ["opus", "sonnet", "haiku", "other"];

interface PoolEntry {
  acctId: AccountId;
  manager: TokenManager;
}

interface PoolOpts {
  clock?: () => number;
}

export class AccountPool {
  protected readonly managers = new Map<AccountId, TokenManager>();
  protected readonly cooldown = new Map<AccountId, Map<ModelTier, number>>();
  protected nextIdx = 0;
  protected readonly clock: () => number;

  constructor(entries: PoolEntry[], opts: PoolOpts = {}) {
    for (const e of entries) this.managers.set(e.acctId, e.manager);
    this.clock = opts.clock ?? Date.now;
  }

  accounts(): AccountId[] {
    return [...this.managers.keys()];
  }

  markCooldown(acctId: AccountId, tier: ModelTier, untilMs: number): void {
    let m = this.cooldown.get(acctId);
    if (!m) { m = new Map(); this.cooldown.set(acctId, m); }
    m.set(tier, untilMs);
  }

  async pickToken(tier: ModelTier, exclude: AccountId[] = []): Promise<{ acctId: AccountId; token: string }> {
    const order = this.accounts();
    if (order.length === 0) throw new Error("AccountPool is empty");

    const excludeSet = new Set(exclude);
    const eligible = order.filter(id => !excludeSet.has(id));
    if (eligible.length === 0) throw new Error("no eligible account after applying exclude list");

    const now = this.clock();

    // Round-robin scan starting at nextIdx, looking for an account whose
    // cooldown for the requested tier has expired.
    for (let i = 0; i < order.length; i++) {
      const idx = (this.nextIdx + i) % order.length;
      const acctId = order[idx]!;
      if (excludeSet.has(acctId)) continue;
      const until = this.cooldown.get(acctId)?.get(tier) ?? 0;
      if (until <= now) {
        this.nextIdx = (idx + 1) % order.length;
        const token = await this.managers.get(acctId)!.getAccessToken();
        return { acctId, token };
      }
    }

    // All eligible accounts are cooled for this tier. Pick the one with the
    // soonest-expiring cooldown.
    let bestId: AccountId | null = null;
    let bestUntil = Number.POSITIVE_INFINITY;
    for (const acctId of eligible) {
      const until = this.cooldown.get(acctId)?.get(tier) ?? Number.POSITIVE_INFINITY;
      if (until < bestUntil) { bestUntil = until; bestId = acctId; }
    }
    if (bestId == null) throw new Error("AccountPool: pickToken found no candidate (unreachable)");
    const token = await this.managers.get(bestId)!.getAccessToken();
    return { acctId: bestId, token };
  }
}

// Re-export so consumers can iterate over the canonical tier order in tests.
export const ALL_TIERS = TIERS;
```

- [ ] **Step 4: Tests pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/pool.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/pool.ts agent/test/pool.test.ts
git commit -m "feat(agent): AccountPool with round-robin selector and per-tier cooldown"
```

---

### Task 4: AccountPool — manually disabled + snapshot + upsert / remove

**Files:**
- Modify: `~/projects/claude-max-proxy/agent/src/pool.ts`
- Modify: `~/projects/claude-max-proxy/agent/test/pool.test.ts`

**Interfaces:**
- Consumes: existing `AccountPool` from Task 3.
- Produces (added to `AccountPool`):
  - `setManuallyDisabled(acctId: AccountId, disabled: boolean): void`
  - `isManuallyDisabled(acctId: AccountId): boolean`
  - `upsertAccount(acctId: AccountId, mgr: TokenManager): void`
  - `removeAccount(acctId: AccountId): void`
  - `snapshot(): PoolSnapshot`
  - Type `PoolSnapshot = { nowMs: number; accounts: AccountSnapshot[] }`
  - Type `AccountSnapshot = { acctId: AccountId; manuallyDisabled: boolean; cooldown: Record<ModelTier, { untilMs: number; remainingS: number } | null>; lastUsedMs: number | null }`
  - The selector also records `lastUsedMs` on every successful pick.

- [ ] **Step 1: Append failing tests**

Append to `~/projects/claude-max-proxy/agent/test/pool.test.ts`:

```ts
describe("AccountPool — admin surface", () => {
  const NOW = 1_700_000_000_000;
  const clock = () => NOW;
  const A = { acctId: "a@x", manager: fakeManager("tok-A") };
  const B = { acctId: "b@y", manager: fakeManager("tok-B") };

  it("setManuallyDisabled / isManuallyDisabled flip atomically", () => {
    const p = new AccountPool([A, B], { clock });
    expect(p.isManuallyDisabled("a@x")).toBe(false);
    p.setManuallyDisabled("a@x", true);
    expect(p.isManuallyDisabled("a@x")).toBe(true);
    p.setManuallyDisabled("a@x", false);
    expect(p.isManuallyDisabled("a@x")).toBe(false);
  });

  it("selector skips manually disabled accounts on every tier", async () => {
    const p = new AccountPool([A, B], { clock });
    p.setManuallyDisabled("a@x", true);
    const picks = [];
    for (let i = 0; i < 3; i++) picks.push((await p.pickToken("haiku")).acctId);
    expect(picks).toEqual(["b@y", "b@y", "b@y"]);
  });

  it("manually-disabled accounts are NOT used in the all-cooled fallback", async () => {
    const p = new AccountPool([A, B], { clock });
    p.setManuallyDisabled("a@x", true);
    p.markCooldown("b@y", "opus", NOW + 30 * 60_000); // cooled but eligible
    const pick = await p.pickToken("opus");
    expect(pick.acctId).toBe("b@y");
  });

  it("upsertAccount adds a fresh account into the rotation", async () => {
    const p = new AccountPool([A], { clock });
    p.upsertAccount("b@y", fakeManager("tok-B-new"));
    expect(p.accounts()).toEqual(["a@x", "b@y"]);
    const first  = await p.pickToken("opus");
    const second = await p.pickToken("opus");
    expect([first.acctId, second.acctId]).toEqual(["a@x", "b@y"]);
  });

  it("removeAccount drops the entry and its cooldown / disabled state", async () => {
    const p = new AccountPool([A, B], { clock });
    p.markCooldown("a@x", "opus", NOW + 60_000);
    p.setManuallyDisabled("a@x", true);
    p.removeAccount("a@x");
    expect(p.accounts()).toEqual(["b@y"]);
    expect(p.isManuallyDisabled("a@x")).toBe(false);
    const pick = await p.pickToken("opus");
    expect(pick.acctId).toBe("b@y");
  });

  it("snapshot reflects cooldown, disabled flag, and last-used time", async () => {
    const p = new AccountPool([A, B], { clock });
    p.markCooldown("a@x", "opus", NOW + 5 * 60_000);
    p.setManuallyDisabled("b@y", true);
    await p.pickToken("haiku"); // marks A as last-used
    const snap = p.snapshot();
    expect(snap.nowMs).toBe(NOW);
    const a = snap.accounts.find(x => x.acctId === "a@x")!;
    const b = snap.accounts.find(x => x.acctId === "b@y")!;
    expect(a.cooldown.opus).toEqual({ untilMs: NOW + 5 * 60_000, remainingS: 300 });
    expect(a.cooldown.sonnet).toBeNull();
    expect(a.lastUsedMs).toBe(NOW);
    expect(b.manuallyDisabled).toBe(true);
    expect(b.lastUsedMs).toBeNull();
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/pool.test.ts
```

Expected: `setManuallyDisabled is not a function`.

- [ ] **Step 3: Implement**

Replace the body of `~/projects/claude-max-proxy/agent/src/pool.ts` with:

```ts
import type { AccountId, ModelTier } from "./types.js";
import type { TokenManager } from "./tokens.js";

const TIERS: ModelTier[] = ["opus", "sonnet", "haiku", "other"];

interface PoolEntry {
  acctId: AccountId;
  manager: TokenManager;
}

interface PoolOpts {
  clock?: () => number;
}

export interface AccountSnapshot {
  acctId: AccountId;
  manuallyDisabled: boolean;
  cooldown: Record<ModelTier, { untilMs: number; remainingS: number } | null>;
  lastUsedMs: number | null;
}

export interface PoolSnapshot {
  nowMs: number;
  accounts: AccountSnapshot[];
}

export class AccountPool {
  protected readonly managers = new Map<AccountId, TokenManager>();
  protected readonly cooldown = new Map<AccountId, Map<ModelTier, number>>();
  protected readonly disabled = new Set<AccountId>();
  protected readonly lastUsed = new Map<AccountId, number>();
  protected nextIdx = 0;
  protected readonly clock: () => number;

  constructor(entries: PoolEntry[], opts: PoolOpts = {}) {
    for (const e of entries) this.managers.set(e.acctId, e.manager);
    this.clock = opts.clock ?? Date.now;
  }

  accounts(): AccountId[] {
    return [...this.managers.keys()];
  }

  markCooldown(acctId: AccountId, tier: ModelTier, untilMs: number): void {
    let m = this.cooldown.get(acctId);
    if (!m) { m = new Map(); this.cooldown.set(acctId, m); }
    m.set(tier, untilMs);
  }

  setManuallyDisabled(acctId: AccountId, disabled: boolean): void {
    if (disabled) this.disabled.add(acctId); else this.disabled.delete(acctId);
  }

  isManuallyDisabled(acctId: AccountId): boolean {
    return this.disabled.has(acctId);
  }

  upsertAccount(acctId: AccountId, manager: TokenManager): void {
    this.managers.set(acctId, manager);
  }

  removeAccount(acctId: AccountId): void {
    this.managers.delete(acctId);
    this.cooldown.delete(acctId);
    this.disabled.delete(acctId);
    this.lastUsed.delete(acctId);
    // Keep nextIdx valid against the (possibly shorter) accounts list.
    const size = this.managers.size;
    if (size > 0) this.nextIdx = this.nextIdx % size;
    else this.nextIdx = 0;
  }

  async pickToken(tier: ModelTier, exclude: AccountId[] = []): Promise<{ acctId: AccountId; token: string }> {
    const order = this.accounts();
    if (order.length === 0) throw new Error("AccountPool is empty");

    const excludeSet = new Set(exclude);
    const eligible = order.filter(id => !excludeSet.has(id) && !this.disabled.has(id));
    if (eligible.length === 0) throw new Error("no eligible account after applying exclude list / disabled flags");

    const now = this.clock();

    // Round-robin scan for the first eligible, non-cooled candidate.
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

    // Every eligible account is cooled for the tier. Pick the soonest-expiring.
    let bestId: AccountId | null = null;
    let bestUntil = Number.POSITIVE_INFINITY;
    for (const acctId of eligible) {
      const until = this.cooldown.get(acctId)?.get(tier) ?? Number.POSITIVE_INFINITY;
      if (until < bestUntil) { bestUntil = until; bestId = acctId; }
    }
    if (bestId == null) throw new Error("AccountPool: pickToken found no candidate (unreachable)");
    return this.use(bestId, now);
  }

  snapshot(): PoolSnapshot {
    const now = this.clock();
    const accounts: AccountSnapshot[] = [];
    for (const acctId of this.managers.keys()) {
      const cooldownMap = this.cooldown.get(acctId);
      const cooldown = TIERS.reduce((acc, tier) => {
        const until = cooldownMap?.get(tier);
        if (until != null && until > now) {
          acc[tier] = { untilMs: until, remainingS: Math.round((until - now) / 1000) };
        } else {
          acc[tier] = null;
        }
        return acc;
      }, {} as AccountSnapshot["cooldown"]);
      accounts.push({
        acctId,
        manuallyDisabled: this.disabled.has(acctId),
        cooldown,
        lastUsedMs: this.lastUsed.get(acctId) ?? null,
      });
    }
    return { nowMs: now, accounts };
  }

  private async use(acctId: AccountId, nowMs: number): Promise<{ acctId: AccountId; token: string }> {
    this.lastUsed.set(acctId, nowMs);
    const token = await this.managers.get(acctId)!.getAccessToken();
    return { acctId, token };
  }
}

export const ALL_TIERS = TIERS;
```

- [ ] **Step 4: Tests pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/pool.test.ts
```

Expected: 15 tests pass (9 from Task 3 + 6 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/pool.ts agent/test/pool.test.ts
git commit -m "feat(agent): AccountPool admin surface (manuallyDisabled, snapshot, upsert/remove)"
```

---

### Task 5: KeychainWatcher

**Files:**
- Create: `~/projects/claude-max-proxy/agent/src/watcher.ts`
- Create: `~/projects/claude-max-proxy/agent/test/watcher.test.ts`

**Interfaces:**
- Consumes: `AccountPool`, `TokenManager`, `OAuthCredential`, `AccountId`.
- Produces:
  - `interface KeychainEnumerator { list(): Promise<AccountId[]>; read(acctId: AccountId): Promise<OAuthCredential | null> }`
  - `type ManagerFactory = (acctId: AccountId) => TokenManager`
  - `class KeychainWatcher`:
    - `constructor(deps: { enumerator: KeychainEnumerator; factory: ManagerFactory; pool: AccountPool; allowlist?: Set<AccountId> | null; intervalMs?: number; clock?: () => number; log?: (msg: string, extra?: object) => void })`
    - `start(): void` — installs `setInterval`
    - `stop(): void` — clears the timer
    - `tick(): Promise<void>` — runs one reconciliation cycle (also exposed for tests)

- [ ] **Step 1: Write the failing tests**

`~/projects/claude-max-proxy/agent/test/watcher.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { KeychainWatcher, type KeychainEnumerator } from "../src/watcher.js";
import { AccountPool } from "../src/pool.js";
import type { TokenManager } from "../src/tokens.js";
import type { OAuthCredential } from "../src/types.js";

function fakeManager(initialToken: string) {
  let token = initialToken;
  return {
    async getAccessToken() { return token; },
    async forceRefresh() { return token; },
    adoptExternalCredential(c: OAuthCredential) { token = c.accessToken; },
    __token() { return token; },
  } as unknown as TokenManager & { __token(): string };
}

function makeEnumerator(state: { ids: string[]; creds: Map<string, OAuthCredential> }): KeychainEnumerator {
  return {
    async list() { return [...state.ids]; },
    async read(id) { return state.creds.get(id) ?? null; },
  };
}

function cred(exp: number, access = "old"): OAuthCredential {
  return { accessToken: access, refreshToken: "rt", expiresAt: exp, scopes: [] };
}

describe("KeychainWatcher", () => {
  it("seeds the pool with newly discovered accounts on the first tick", async () => {
    const state = { ids: ["a@x", "b@y"], creds: new Map([
      ["a@x", cred(1_700_000_000_000 + 60_000, "tok-A")],
      ["b@y", cred(1_700_000_000_000 + 60_000, "tok-B")],
    ]) };
    const pool = new AccountPool([]);
    const w = new KeychainWatcher({
      enumerator: makeEnumerator(state),
      factory: (id) => fakeManager(`mgr-for-${id}`),
      pool,
    });
    await w.tick();
    expect(pool.accounts().sort()).toEqual(["a@x", "b@y"]);
  });

  it("removes accounts that disappear from the Keychain enumerator", async () => {
    const state = { ids: ["a@x", "b@y"], creds: new Map<string, OAuthCredential>() };
    const pool = new AccountPool([]);
    const w = new KeychainWatcher({
      enumerator: makeEnumerator(state),
      factory: (id) => fakeManager(`mgr-for-${id}`),
      pool,
    });
    await w.tick();
    expect(pool.accounts().sort()).toEqual(["a@x", "b@y"]);
    state.ids = ["a@x"]; // b@y deleted externally
    await w.tick();
    expect(pool.accounts()).toEqual(["a@x"]);
  });

  it("calls adoptExternalCredential when a stored credential's expiresAt advances", async () => {
    const old = cred(1_700_000_000_000 + 60_000, "old");
    const newer = cred(1_700_000_000_000 + 8 * 3_600_000, "new");
    const state = { ids: ["a@x"], creds: new Map([["a@x", old]]) };
    const m = fakeManager("seed");
    const pool = new AccountPool([{ acctId: "a@x", manager: m }]);
    const w = new KeychainWatcher({
      enumerator: makeEnumerator(state),
      factory: () => m,
      pool,
    });
    await w.tick(); // first tick records the current credential
    state.creds.set("a@x", newer);
    await w.tick(); // second tick sees the newer credential
    expect((m as any).__token()).toBe("new");
  });

  it("respects the allowlist: enumerator returns 3, allowlist names 2 → pool has 2", async () => {
    const state = { ids: ["a@x", "b@y", "c@z"], creds: new Map() };
    const pool = new AccountPool([]);
    const w = new KeychainWatcher({
      enumerator: makeEnumerator(state),
      factory: (id) => fakeManager(`mgr-${id}`),
      pool,
      allowlist: new Set(["a@x", "c@z"]),
    });
    await w.tick();
    expect(pool.accounts().sort()).toEqual(["a@x", "c@z"]);
  });

  it("swallows enumerator failures without throwing out of the tick", async () => {
    const failing: KeychainEnumerator = {
      async list() { throw new Error("security died"); },
      async read() { throw new Error("never read"); },
    };
    const pool = new AccountPool([]);
    const logs: string[] = [];
    const w = new KeychainWatcher({
      enumerator: failing,
      factory: (id) => fakeManager(`mgr-${id}`),
      pool,
      log: (msg) => { logs.push(msg); },
    });
    await expect(w.tick()).resolves.toBeUndefined();
    expect(logs.some(l => /security died/.test(l))).toBe(true);
  });

  it("start/stop installs and clears the interval", async () => {
    vi.useFakeTimers();
    const state = { ids: [], creds: new Map() };
    const pool = new AccountPool([]);
    const w = new KeychainWatcher({
      enumerator: makeEnumerator(state),
      factory: (id) => fakeManager(`mgr-${id}`),
      pool,
      intervalMs: 5_000,
    });
    w.start();
    expect(vi.getTimerCount()).toBe(1);
    w.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/watcher.test.ts
```

Expected: file-not-found.

- [ ] **Step 3: Implement**

`~/projects/claude-max-proxy/agent/src/watcher.ts`:

```ts
import type { AccountPool } from "./pool.js";
import type { TokenManager } from "./tokens.js";
import type { AccountId, OAuthCredential } from "./types.js";

export interface KeychainEnumerator {
  list(): Promise<AccountId[]>;
  read(acctId: AccountId): Promise<OAuthCredential | null>;
}

export type ManagerFactory = (acctId: AccountId) => TokenManager;

interface WatcherDeps {
  enumerator: KeychainEnumerator;
  factory: ManagerFactory;
  pool: AccountPool;
  allowlist?: Set<AccountId> | null;
  intervalMs?: number;
  clock?: () => number;
  log?: (msg: string, extra?: object) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;

export class KeychainWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly known = new Map<AccountId, number>(); // acctId -> last-seen expiresAt
  private readonly enumerator: KeychainEnumerator;
  private readonly factory: ManagerFactory;
  private readonly pool: AccountPool;
  private readonly allowlist: Set<AccountId> | null;
  private readonly intervalMs: number;
  private readonly log: (msg: string, extra?: object) => void;

  constructor(deps: WatcherDeps) {
    this.enumerator = deps.enumerator;
    this.factory = deps.factory;
    this.pool = deps.pool;
    this.allowlist = deps.allowlist ?? null;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    let listed: AccountId[];
    try {
      listed = await this.enumerator.list();
    } catch (e) {
      this.log(`KeychainWatcher: enumerator.list failed: ${(e as Error).message}`);
      return;
    }

    const allowed = this.allowlist
      ? listed.filter(id => this.allowlist!.has(id))
      : listed;
    const allowedSet = new Set(allowed);

    // 1. Reconcile additions.
    for (const acctId of allowed) {
      if (!this.pool.accounts().includes(acctId)) {
        try {
          const mgr = this.factory(acctId);
          this.pool.upsertAccount(acctId, mgr);
          this.known.set(acctId, 0);
        } catch (e) {
          this.log(`KeychainWatcher: factory(${acctId}) failed: ${(e as Error).message}`);
        }
      }
    }

    // 2. Reconcile removals.
    for (const acctId of this.pool.accounts()) {
      if (!allowedSet.has(acctId)) {
        this.pool.removeAccount(acctId);
        this.known.delete(acctId);
      }
    }

    // 3. Adopt external credential rotations.
    for (const acctId of this.pool.accounts()) {
      try {
        const cred = await this.enumerator.read(acctId);
        if (!cred) continue;
        const lastExp = this.known.get(acctId) ?? 0;
        if (cred.expiresAt > lastExp) {
          // The pool stores TokenManagers; we need the manager to adopt.
          // The pool only exposes `accounts()`. Build a tiny back-channel:
          // we rely on the factory having produced the manager that the pool
          // now owns; the pool exposes pickToken but not the manager itself.
          // So we ask the pool to surface it via a get accessor — added below.
          const mgr = (this.pool as unknown as { managers: Map<AccountId, TokenManager> }).managers.get(acctId);
          if (mgr) {
            mgr.adoptExternalCredential(cred);
            this.known.set(acctId, cred.expiresAt);
          }
        }
      } catch (e) {
        this.log(`KeychainWatcher: read(${acctId}) failed: ${(e as Error).message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Tests pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/watcher.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: TypeScript clean**

```bash
cd ~/projects/claude-max-proxy/agent && npx tsc --noEmit -p tsconfig.json
```

Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/watcher.ts agent/test/watcher.test.ts
git commit -m "feat(agent): KeychainWatcher reconciles pool roster and adopts external credentials"
```

---

### Task 6: Upstream — selector-driven calls with failover

**Files:**
- Modify: `~/projects/claude-max-proxy/agent/src/upstream.ts`
- Modify: `~/projects/claude-max-proxy/agent/test/upstream.test.ts`

**Interfaces:**
- Consumes: `AccountPool`, `modelTierOf`, `retryAfterMs`.
- Produces:
  - New exported signature: `callUpstreamRotating(body: Buffer, acceptHeader: string, pool: AccountPool, opts?: { maxAttempts?: number; nowMs?: () => number; log?: (msg: string, extra?: object) => void }): Promise<Response>`
  - The existing `callUpstream(body, accept, tokens)` signature is kept for backward-compat (delegates internally to a one-shot path with a single TokenManager wrapped in a tiny pool).

- [ ] **Step 1: Write the failing tests** *(append to `upstream.test.ts`)*

```ts
import { AccountPool } from "../src/pool.js";
import { callUpstreamRotating } from "../src/upstream.js";

describe("callUpstreamRotating", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function poolOf(...entries: Array<{ acctId: string; token: string }>) {
    return new AccountPool(entries.map(e => ({
      acctId: e.acctId,
      manager: {
        async getAccessToken() { return e.token; },
        async forceRefresh() { return e.token; },
        adoptExternalCredential() {},
      } as never,
    })), { clock: () => 1_700_000_000_000 });
  }

  it("on 429 from account A, retries with account B and returns B's response", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
        { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const pool = poolOf({ acctId: "a@x", token: "tok-A" }, { acctId: "b@y", token: "tok-B" });
    const body = Buffer.from(JSON.stringify({ model: "claude-opus-4-7" }));
    const res = await callUpstreamRotating(body, "application/json", pool);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth1 = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers as HeadersInit).get("authorization");
    const auth2 = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers as HeadersInit).get("authorization");
    expect(auth1).toBe("Bearer tok-A");
    expect(auth2).toBe("Bearer tok-B");
  });

  it("caps at 3 total attempts and returns the last 429 to the client", async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
      { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
    ));
    const pool = poolOf(
      { acctId: "a@x", token: "tok-A" },
      { acctId: "b@y", token: "tok-B" },
      { acctId: "c@z", token: "tok-C" },
      { acctId: "d@w", token: "tok-D" },
    );
    const body = Buffer.from(JSON.stringify({ model: "claude-opus-4-7" }));
    const res = await callUpstreamRotating(body, "application/json", pool);
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not fail over on non-429 errors (4xx / 5xx pass through)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    const pool = poolOf({ acctId: "a@x", token: "tok-A" }, { acctId: "b@y", token: "tok-B" });
    const body = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5" }));
    const res = await callUpstreamRotating(body, "application/json", pool);
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/upstream.test.ts
```

Expected: `callUpstreamRotating is not exported`.

- [ ] **Step 3: Implement**

Append to `~/projects/claude-max-proxy/agent/src/upstream.ts`:

```ts
import { AccountPool } from "./pool.js";
import { modelTierOf, retryAfterMs } from "./tier.js";

const MAX_ATTEMPTS_DEFAULT = 3;

interface RotatingOpts {
  maxAttempts?: number;
  nowMs?: () => number;
  log?: (msg: string, extra?: object) => void;
}

export async function callUpstreamRotating(
  body: Buffer,
  acceptHeader: string,
  pool: AccountPool,
  opts: RotatingOpts = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const log = opts.log ?? (() => {});

  // Derive the tier once from the request body so cooldown bookkeeping is
  // consistent across retries.
  let model: string | undefined;
  try { model = JSON.parse(body.toString("utf-8"))?.model; }
  catch { /* leave undefined; tier resolves to "other" */ }
  const tier = modelTierOf(model ?? null);

  const tried: string[] = [];
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { acctId, token } = await pool.pickToken(tier, tried);
    tried.push(acctId);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-version": "2023-06-01",
        "x-app": "cli",
        "content-type": "application/json",
        "user-agent": "claude-max-proxy/0.2",
        accept: acceptHeader || "application/json",
      },
      body,
    });

    if (res.status !== 429) {
      log("upstream: response", { acctId, tier, status: res.status });
      return res;
    }

    // Drain the body so we can inspect it AND still return it if this is the
    // last attempt. Body is small (Anthropic 429s are JSON envelopes).
    const text = await res.text();
    let isRateLimit = false;
    try { isRateLimit = JSON.parse(text)?.error?.type === "rate_limit_error"; }
    catch { /* malformed; treat as cool-down to be safe */ isRateLimit = true; }

    const replay = new Response(text, { status: res.status, headers: res.headers });
    lastResponse = replay;

    if (isRateLimit) {
      const cooldown = retryAfterMs(res, nowMs());
      pool.markCooldown(acctId, tier, nowMs() + cooldown);
      log("upstream: rate-limit; cooled", { acctId, tier, cooldownMs: cooldown });
      continue;
    }

    // 429 without rate_limit_error envelope — return as-is, no retry.
    return replay;
  }

  return lastResponse!; // last 429 after exhausting attempts
}
```

- [ ] **Step 4: Tests pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/upstream.test.ts
```

Expected: existing 4 + 3 new = 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/upstream.ts agent/test/upstream.test.ts
git commit -m "feat(agent): callUpstreamRotating with 429 failover across pool accounts"
```

---

### Task 7: Admin handlers

**Files:**
- Create: `~/projects/claude-max-proxy/agent/src/admin.ts`
- Create: `~/projects/claude-max-proxy/agent/test/admin.test.ts`

**Interfaces:**
- Consumes: `AccountPool`.
- Produces:
  - `interface AdminDeps { pool: AccountPool }`
  - `handleAccountsSnapshot(deps: AdminDeps): Response`
  - `handleAccountsDisable(deps: AdminDeps, acctId: string, rawBody: string): Response`
  - `handleAccountsEnable(deps: AdminDeps, acctId: string): Response`

- [ ] **Step 1: Write the failing tests**

`~/projects/claude-max-proxy/agent/test/admin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AccountPool } from "../src/pool.js";
import { handleAccountsSnapshot, handleAccountsDisable, handleAccountsEnable } from "../src/admin.js";
import type { TokenManager } from "../src/tokens.js";

function fakeManager(token: string): TokenManager {
  return {
    async getAccessToken() { return token; },
    async forceRefresh() { return token; },
    adoptExternalCredential() {},
  } as unknown as TokenManager;
}

const NOW = 1_700_000_000_000;
const clock = () => NOW;

describe("admin handlers", () => {
  it("snapshot returns the pool state in JSON shape", async () => {
    const pool = new AccountPool([
      { acctId: "a@x", manager: fakeManager("tA") },
      { acctId: "b@y", manager: fakeManager("tB") },
    ], { clock });
    pool.markCooldown("a@x", "opus", NOW + 5 * 60_000);
    pool.setManuallyDisabled("b@y", true);
    const res = handleAccountsSnapshot({ pool });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.now_ms).toBe(NOW);
    const a = body.accounts.find((x: any) => x.acct_id === "a@x");
    expect(a.cooldown.opus).toEqual({ until_ms: NOW + 5 * 60_000, remaining_s: 300 });
    expect(a.cooldown.haiku).toBeNull();
    expect(a.manually_disabled).toBe(false);
    const b = body.accounts.find((x: any) => x.acct_id === "b@y");
    expect(b.manually_disabled).toBe(true);
  });

  it("disable + enable flip the flag and 404 for unknown accounts", async () => {
    const pool = new AccountPool([
      { acctId: "a@x", manager: fakeManager("tA") },
    ], { clock });
    let res = handleAccountsDisable({ pool }, "a@x", "");
    expect(res.status).toBe(200);
    expect(pool.isManuallyDisabled("a@x")).toBe(true);

    res = handleAccountsEnable({ pool }, "a@x");
    expect(res.status).toBe(200);
    expect(pool.isManuallyDisabled("a@x")).toBe(false);

    res = handleAccountsDisable({ pool }, "missing@x", "");
    expect(res.status).toBe(404);
  });

  it("disable parses optional JSON body with reason", async () => {
    const pool = new AccountPool([
      { acctId: "a@x", manager: fakeManager("tA") },
    ], { clock });
    const res = handleAccountsDisable({ pool }, "a@x", JSON.stringify({ reason: "manual cooldown" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("manual cooldown");
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/admin.test.ts
```

Expected: file-not-found.

- [ ] **Step 3: Implement**

`~/projects/claude-max-proxy/agent/src/admin.ts`:

```ts
import type { AccountPool, PoolSnapshot, AccountSnapshot } from "./pool.js";

export interface AdminDeps {
  pool: AccountPool;
}

export function handleAccountsSnapshot(deps: AdminDeps): Response {
  const snap = deps.pool.snapshot();
  const body = wireSnapshot(snap);
  return json(200, body);
}

export function handleAccountsDisable(deps: AdminDeps, acctId: string, rawBody: string): Response {
  if (!deps.pool.accounts().includes(acctId)) return json(404, errBody("not_found", `no such account: ${acctId}`));
  let reason: string | undefined;
  if (rawBody.length > 0) {
    try {
      const parsed = JSON.parse(rawBody) as { reason?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
    } catch { /* ignore */ }
  }
  deps.pool.setManuallyDisabled(acctId, true);
  return json(200, { acct_id: acctId, manually_disabled: true, reason: reason ?? null });
}

export function handleAccountsEnable(deps: AdminDeps, acctId: string): Response {
  if (!deps.pool.accounts().includes(acctId)) return json(404, errBody("not_found", `no such account: ${acctId}`));
  deps.pool.setManuallyDisabled(acctId, false);
  return json(200, { acct_id: acctId, manually_disabled: false });
}

function wireSnapshot(snap: PoolSnapshot): Record<string, unknown> {
  return {
    now_ms: snap.nowMs,
    accounts: snap.accounts.map(wireAccount),
  };
}

function wireAccount(a: AccountSnapshot): Record<string, unknown> {
  const cooldown: Record<string, unknown> = {};
  for (const tier of ["opus", "sonnet", "haiku", "other"] as const) {
    const c = a.cooldown[tier];
    cooldown[tier] = c ? { until_ms: c.untilMs, remaining_s: c.remainingS } : null;
  }
  return {
    acct_id: a.acctId,
    manually_disabled: a.manuallyDisabled,
    cooldown,
    last_used_ms: a.lastUsedMs,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errBody(type: string, message: string): Record<string, unknown> {
  return { error: { type, message } };
}
```

- [ ] **Step 4: Tests pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/admin.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/admin.ts agent/test/admin.test.ts
git commit -m "feat(agent): admin HTTP handlers (snapshot, disable, enable)"
```

---

### Task 8: Server wiring — admin routes and pool-based upstream

**Files:**
- Modify: `~/projects/claude-max-proxy/agent/src/server.ts`
- Modify: `~/projects/claude-max-proxy/agent/test/server.test.ts`

**Interfaces:**
- Consumes: `AccountPool`, the new `admin.ts` handlers, `callUpstreamRotating`.
- Produces: server with three routes — `POST /v1/messages` (rotating upstream), `GET /v1/admin/accounts`, `POST /v1/admin/accounts/{id}/(disable|enable)`. The `ServerDeps` shape changes to take a pool instead of a bound upstream function.

- [ ] **Step 1: Modify the existing tests + add admin tests**

Replace the existing `~/projects/claude-max-proxy/agent/test/server.test.ts` content with:

```ts
import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.js";
import { AccountPool } from "../src/pool.js";

function poolWith(...entries: Array<{ acctId: string; token: string }>) {
  return new AccountPool(entries.map(e => ({
    acctId: e.acctId,
    manager: {
      async getAccessToken() { return e.token; },
      async forceRefresh() { return e.token; },
      adoptExternalCredential() {},
    } as never,
  })), { clock: () => 1_700_000_000_000 });
}

function startServer(deps: Parameters<typeof createServer>[0]) {
  const server = createServer(deps);
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
  it("POST /v1/messages routes through the rotating upstream and pipes the response", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const upstreamFake = vi.fn(async () => new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }));
    const { server, url } = await startServer({ pool, upstream: upstreamFake });
    try {
      const r = await post(`${url}/v1/messages`, JSON.stringify({ model: "claude-haiku-4-5" }));
      expect(r.status).toBe(200);
      expect(r.body).toBe("hi");
      expect(upstreamFake).toHaveBeenCalledTimes(1);
    } finally { server.close(); }
  });

  it("POST /v1/messages with non-JSON body returns 400", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("ok") });
    try {
      const r = await post(`${url}/v1/messages`, "not-json");
      expect(r.status).toBe(400);
    } finally { server.close(); }
  });

  it("GET /v1/admin/accounts returns the snapshot", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("") });
    try {
      const res = await fetch(`${url}/v1/admin/accounts`);
      expect(res.status).toBe(200);
      const body = await res.json() as { accounts: Array<{ acct_id: string }> };
      expect(body.accounts.map(a => a.acct_id)).toEqual(["a@x"]);
    } finally { server.close(); }
  });

  it("POST /v1/admin/accounts/{id}/disable + /enable flip and persist", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("") });
    try {
      let res = await fetch(`${url}/v1/admin/accounts/a%40x/disable`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(pool.isManuallyDisabled("a@x")).toBe(true);
      res = await fetch(`${url}/v1/admin/accounts/a%40x/enable`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(pool.isManuallyDisabled("a@x")).toBe(false);
    } finally { server.close(); }
  });

  it("unknown route returns 404", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("") });
    try {
      const r = await post(`${url}/unknown`, "{}");
      expect(r.status).toBe(404);
    } finally { server.close(); }
  });
});
```

- [ ] **Step 2: Watch them fail**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/server.test.ts
```

Expected: type errors on `ServerDeps` shape.

- [ ] **Step 3: Implement**

Replace `~/projects/claude-max-proxy/agent/src/server.ts` content with:

```ts
import * as http from "node:http";
import type { AccountPool } from "./pool.js";
import { handleAccountsSnapshot, handleAccountsDisable, handleAccountsEnable } from "./admin.js";

export interface ServerDeps {
  pool: AccountPool;
  upstream: (body: Buffer, accept: string, pool: AccountPool) => Promise<Response>;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "content-encoding", "content-length",
]);

const ADMIN_DISABLE = /^\/v1\/admin\/accounts\/([^/]+)\/disable$/;
const ADMIN_ENABLE  = /^\/v1\/admin\/accounts\/([^/]+)\/enable$/;

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/messages") {
        return handleMessages(req, res, deps);
      }
      if (req.method === "GET" && url === "/v1/admin/accounts") {
        return pipeResponse(res, handleAccountsSnapshot({ pool: deps.pool }));
      }
      if (req.method === "POST") {
        const disableMatch = url.match(ADMIN_DISABLE);
        if (disableMatch) {
          const acctId = decodeURIComponent(disableMatch[1]!);
          const body = (await collectBody(req)).toString("utf-8");
          return pipeResponse(res, handleAccountsDisable({ pool: deps.pool }, acctId, body));
        }
        const enableMatch = url.match(ADMIN_ENABLE);
        if (enableMatch) {
          const acctId = decodeURIComponent(enableMatch[1]!);
          return pipeResponse(res, handleAccountsEnable({ pool: deps.pool }, acctId));
        }
      }
      sendJson(res, 404, { error: { type: "not_found", message: req.method + " " + url + " not handled" } });
    } catch (err) {
      console.error("[agent] handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: { type: "internal_error", message: String(err) } });
      else res.end();
    }
  });
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps) {
  const body = await collectBody(req);
  try { JSON.parse(body.toString("utf-8")); }
  catch { return sendJson(res, 400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } }); }
  const accept = pickHeader(req.headers["accept"]) ?? "application/json";
  const upstream = await deps.upstream(body, accept, deps.pool);
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
}

async function pipeResponse(res: http.ServerResponse, source: Response): Promise<void> {
  res.statusCode = source.status;
  for (const [k, v] of source.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }
  const text = await source.text();
  res.end(text);
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

- [ ] **Step 4: Tests pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run test/server.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/server.ts agent/test/server.test.ts
git commit -m "feat(agent): server routes admin endpoints and uses AccountPool upstream"
```

---

### Task 9: Entry point — pool + watcher + Keychain enumerator + env override

**Files:**
- Modify: `~/projects/claude-max-proxy/agent/src/index.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable agent that on startup constructs the AccountPool empty, builds a real `KeychainEnumerator` backed by `security` shell-outs, starts the `KeychainWatcher` with a 5s tick, and serves HTTP on port 8787 routing through `callUpstreamRotating`.

- [ ] **Step 1: Replace the index entry point**

`~/projects/claude-max-proxy/agent/src/index.ts`:

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
import type { AccountId, OAuthCredential } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOCK_PATH = path.join(os.homedir(), ".claude", ".proxy-refresh.lock");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function allowlistFromEnv(): Set<AccountId> | null {
  const raw = process.env.CLAUDE_MAX_ACCOUNTS;
  if (!raw) return null;
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return new Set(ids);
}

const realEnumerator: KeychainEnumerator = {
  async list(): Promise<AccountId[]> {
    const { stdout, code } = await runSecurity(["dump-keychain"]);
    if (code !== 0) return [];
    const ids = new Set<AccountId>();
    let inEntry = false;
    let svceMatch = false;
    let acctVal: string | null = null;
    for (const line of stdout.split("\n")) {
      const svce = line.match(/"svce"<blob>="([^"]*)"/);
      if (svce) { svceMatch = svce[1] === KEYCHAIN_SERVICE; }
      const acct = line.match(/"acct"<blob>="([^"]*)"/);
      if (acct) { acctVal = acct[1]!; }
      // Entries end at the next "class:" line or "keychain:" line.
      if (line.startsWith("class:") || line.startsWith("keychain:")) {
        if (svceMatch && acctVal) ids.add(acctVal);
        svceMatch = false;
        acctVal = null;
      }
      void inEntry;
    }
    if (svceMatch && acctVal) ids.add(acctVal);
    return [...ids];
  },
  async read(acctId: AccountId): Promise<OAuthCredential | null> {
    const store = new KeychainStore(acctId);
    try { return await store.read(); }
    catch { return null; }
  },
};

function makeManager(acctId: AccountId): TokenManager {
  return new TokenManager(
    new KeychainStore(acctId),
    new PlatformRefreshClient(),
    makeFileLock(LOCK_PATH),
  );
}

async function main() {
  const pool = new AccountPool([]);

  const watcher = new KeychainWatcher({
    enumerator: realEnumerator,
    factory: makeManager,
    pool,
    allowlist: allowlistFromEnv(),
    intervalMs: 5_000,
    log: (msg, extra) => console.warn(`[agent] ${msg}`, extra ?? ""),
  });

  // Seed the pool with a synchronous first tick so the server doesn't accept
  // requests before any account is known.
  await watcher.tick();
  if (pool.accounts().length === 0) {
    console.error("[agent] no Max-account Keychain entries discovered under service " +
      `'${KEYCHAIN_SERVICE}'. Capture at least one (see docs/operations/capturing-multi-account-credentials.md).`);
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

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Build cleanly**

```bash
cd ~/projects/claude-max-proxy/agent && npx tsc -p tsconfig.json
```

Expected: exit code 0; `dist/` populated.

- [ ] **Step 3: All tests still pass**

```bash
cd ~/projects/claude-max-proxy/agent && npx vitest run
```

Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/claude-max-proxy
git add agent/src/index.ts
git commit -m "feat(agent): entry point wires AccountPool + KeychainWatcher + rotating upstream"
```

---

### Task 10: Capture helper + operations doc

**Files:**
- Create: `~/projects/claude-max-proxy/scripts/capture-max-account.sh`
- Create: `~/projects/claude-max-proxy/docs/operations/capturing-multi-account-credentials.md`

**Interfaces:**
- Produces: a self-contained shell script that takes the just-written
  Keychain entry produced by `claude` login and renames its `acct` field to
  the Max-account email the operator passes in. Plus an operational guide.

- [ ] **Step 1: Write the helper script**

`~/projects/claude-max-proxy/scripts/capture-max-account.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# capture-max-account.sh — promote the default Keychain entry that `claude` just
# wrote into a stable, account-specific entry so the next `claude login` won't
# overwrite it.
#
# Usage: capture-max-account.sh <max-account-email>
#
# What it does:
#   1. Reads the default `Claude Code-credentials` entry (account = current
#      macOS login user).
#   2. Re-stores it under acct=<email> so the proxy agent can discover it.
#   3. Deletes the default-named entry so the next `claude` login starts clean.

SVC="Claude Code-credentials"
DEFAULT_ACCT="$(id -un)"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <max-account-email>" >&2
  exit 64
fi

NEW_ACCT="$1"

# Read the JSON value from the default entry (-w prints just the password).
PAYLOAD="$(security find-generic-password -s "$SVC" -a "$DEFAULT_ACCT" -w 2>/dev/null || true)"
if [[ -z "$PAYLOAD" ]]; then
  echo "error: no Keychain entry found under svce='$SVC', acct='$DEFAULT_ACCT'." >&2
  echo "       Did you run 'claude' to log in first?" >&2
  exit 65
fi

# Quick sanity check: must look like the claudeAiOauth envelope.
if ! grep -q '"claudeAiOauth"' <<<"$PAYLOAD"; then
  echo "error: default entry doesn't look like a Claude OAuth credential." >&2
  exit 66
fi

# Pipe the payload via stdin so the secret doesn't appear in argv.
security add-generic-password -U -s "$SVC" -a "$NEW_ACCT" -w "$PAYLOAD"

# Delete the default-named entry so the next 'claude' login starts clean.
security delete-generic-password -s "$SVC" -a "$DEFAULT_ACCT" >/dev/null

echo "captured Keychain entry under acct='$NEW_ACCT'."
echo "next: run 'claude logout && claude' to log in as the next Max account, then run this script again."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x ~/projects/claude-max-proxy/scripts/capture-max-account.sh
```

- [ ] **Step 3: Write the operations guide**

`~/projects/claude-max-proxy/docs/operations/capturing-multi-account-credentials.md`:

```markdown
# Capturing multiple Max-account OAuth credentials

The proxy agent rotates across every Keychain entry under service
`Claude Code-credentials` whose `acct` field is a stable account ID
(typically the Max-account email). The stock `claude` CLI writes ONE
entry under `acct = $(id -un)` and overwrites it on every login, so
capturing N accounts is a small manual dance.

## One-time setup per account

For each Max-account email (`bob.jansen@pm.me`,
`bob.jansen@wearetriple.com`, `bob@topolab.nl`, `support@topolab.nl`):

1. Log out of any current session:
   ```sh
   claude logout
   ```
2. Log in as the new account:
   ```sh
   claude
   ```
   Complete the browser flow.
3. Promote the just-written Keychain entry:
   ```sh
   scripts/capture-max-account.sh bob.jansen@pm.me
   ```
   Replace the argument with the email of the account you just logged in
   with. The script reads the default-named entry, re-stores it under
   `acct=<email>`, and deletes the default so the next `claude` login
   starts clean.

After all four accounts are captured, `security dump-keychain | grep -B1
'Claude Code-credentials'` should show four `acct` lines — one per
email.

## Verifying the agent sees them

Within 5 seconds of any new entry appearing, the agent's
KeychainWatcher reconciles the pool. Check via the admin endpoint:

```sh
curl -sS http://127.0.0.1:8787/v1/admin/accounts | jq '.accounts[].acct_id'
```

## Disabling an account temporarily

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/disable
```

Re-enable:

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/enable
```

The manual-disable flag is in-memory only; an agent restart clears it.

## Allowlisting accounts

Set `CLAUDE_MAX_ACCOUNTS=<email1>,<email2>` in the agent's launchd plist
to restrict the pool to a subset, without removing the Keychain
entries. Useful for temporarily routing around a broken account.

## Removing an account

Simply delete the Keychain entry:

```sh
security delete-generic-password -s "Claude Code-credentials" -a "<email>"
```

The watcher's next tick drops it from the pool.
```

- [ ] **Step 4: Commit**

```bash
cd ~/projects/claude-max-proxy
git add scripts/capture-max-account.sh docs/operations/capturing-multi-account-credentials.md
git commit -m "ops(agent): capture-max-account helper and multi-account ops guide"
```

---

### Task 11: Build, launchd restart, smoke against real Anthropic, push

**Files:** (no new files — operational verification)

**Interfaces:** end-to-end happy-path + the admin surface against the live agent.

- [ ] **Step 1: Capture the second account (operator step, optional)**

If only one Keychain entry exists today (`acct = bob.jansen`), promote it
to its real email so the pool has a stable name:

```bash
# example — replace with the email that actually owns the credential
~/projects/claude-max-proxy/scripts/capture-max-account.sh bob.jansen@pm.me
```

Repeat per account as time allows. The pool works with as few as one.

- [ ] **Step 2: Build + restart the launchd-managed agent**

```bash
cd ~/projects/claude-max-proxy/agent && npm run build && \
  launchctl kickstart -k "gui/$(id -u)/com.bobjansen.claude-max-proxy" && \
  sleep 1 && tail -3 ~/Library/Logs/claude-max-proxy.out.log
```

Expected: `[agent] listening on http://127.0.0.1:8787 (accounts: <one or more>)`.

- [ ] **Step 3: Snapshot the pool**

```bash
curl -sS http://127.0.0.1:8787/v1/admin/accounts | python3 -m json.tool | head -30
```

Expected: JSON with at least one `acct_id` entry, all cooldown tiers
null on first start.

- [ ] **Step 4: Smoke a real request**

```bash
PROXY_KEY=$(cat ~/.claude-max-proxy.key) # if still using direct-to-agent auth
curl -sS -X POST http://127.0.0.1:8787/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"PONG"}]}' \
  | head -c 200; echo
```

Expected: `"type":"message"` in the response.

- [ ] **Step 5: Verify last-used reflects the smoke call**

```bash
curl -sS http://127.0.0.1:8787/v1/admin/accounts | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['accounts'])"
```

Expected: one account has a non-null `last_used_ms`.

- [ ] **Step 6: Try the disable/enable surface**

```bash
ACCT=$(curl -sS http://127.0.0.1:8787/v1/admin/accounts | python3 -c "import sys,json;print(json.load(sys.stdin)['accounts'][0]['acct_id'])")
curl -i -sS -X POST "http://127.0.0.1:8787/v1/admin/accounts/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$ACCT")/disable" | head -n1
curl -sS http://127.0.0.1:8787/v1/admin/accounts | python3 -c "import sys,json;a=json.load(sys.stdin)['accounts'][0];print('disabled?', a['manually_disabled'])"
curl -i -sS -X POST "http://127.0.0.1:8787/v1/admin/accounts/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$ACCT")/enable" | head -n1
```

Expected: 200/disabled=True, then 200/disabled=False on enable.

- [ ] **Step 7: Push the branch**

```bash
cd ~/projects/claude-max-proxy
git push -u origin feature/CMP-002-multi-account-rotation
```

Expected: branch created on GitHub; URL printed for opening the PR.

- [ ] **Step 8: Open the PR via the web UI**

Navigate to the URL printed by the push (or
`https://github.com/bbjansen/claude-max-proxy/pull/new/feature/CMP-002-multi-account-rotation`)
and submit with a body summarising the spec and confirming the smoke
tests passed.

---

## Spec coverage check

- Goal 1 (load-balance) — Task 3 (round-robin pickToken).
- Goal 2 (per-(account, tier) cooldown) — Task 3 + Task 6 (markCooldown on 429).
- Goal 3 (auto recover with retry-after / 5min default) — Task 1 (retryAfterMs) + Task 6.
- Goal 4 (runtime account add/remove) — Task 4 (upsertAccount/removeAccount) + Task 5 (watcher reconciles).
- Goal 5 (pick up external refresh) — Task 2 (adoptExternalCredential) + Task 5 (watcher detects newer expiresAt).
- Goal 6 (observability + admin surface) — Task 4 (snapshot, lastUsedMs) + Task 7 (handlers) + Task 8 (routes) + Task 9 (per-request log).
- Non-goal "no persistent cooldown" — honored, all in-memory.
- Non-goal "no admin endpoint" — flipped in the spec; covered by Tasks 7/8.
- Architecture diagram — Tasks 3, 4, 5, 6, 8, 9.
- Components: AccountId/ModelTier (Task 1), TokenManager addition (Task 2), AccountPool (Tasks 3 + 4), Selector (Task 3), Cooldown (Tasks 3 + 4), KeychainWatcher (Task 5), Configuration (Task 9).
- Admin HTTP endpoint shape — Task 7 + 8.
- Data flow — Task 6 (rotating upstream) + Task 8 (server wiring).
- Error handling table — covered (3 attempts, all-cooled fallback, refresh-failure cooldown via existing TokenManager 401-retry, empty-pool startup error in Task 9).
- Testing — covered per task.
- Project layout — matches Task 1/3/4/5/7/8/9/10 file paths.
- Operational capture procedure — Task 10.
- Risks — file lock contention is documented; per-account lock filename is *deferred* (acceptable per spec).

No gaps.
