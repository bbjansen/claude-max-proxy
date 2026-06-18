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
    state.ids = ["a@x"];
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
    await w.tick();
    state.creds.set("a@x", newer);
    await w.tick();
    expect((m as unknown as { __token(): string }).__token()).toBe("new");
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
