import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager, PlatformRefreshClient } from "../src/tokens.js";
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

    await tm.getAccessToken();
    expect(await tm.forceRefresh()).toBe("sk-ant-oat01-FORCED");
    expect(refresher.refresh).toHaveBeenCalledTimes(1);
  });

  it("PlatformRefreshClient.refresh tolerates a response with no refresh_token and reuses the old one (RFC 6749 §6)", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "sk-ant-oat01-FRESH",
      expires_in: 3600,
      // refresh_token deliberately omitted
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = new PlatformRefreshClient();
      const result = await client.refresh("sk-ant-ort01-OLD");
      expect(result.accessToken).toBe("sk-ant-oat01-FRESH");
      expect(result.refreshToken).toBe("sk-ant-ort01-OLD");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forceRefresh never silently joins an abandoning non-forced refresh — refresher is always called", async () => {
    // Simulate: a non-forced refresh would abandon (its re-read inside the
    // lock shows an externally-rotated fresh credential), while a forced
    // refresh is fired concurrently because the caller saw a 401. The
    // pre-fix code joined them and called refresher.refresh ZERO times,
    // causing the caller to retry with the already-invalid externally-fresh
    // token. The fix: forceRefresh must always cause refresher.refresh to
    // run, regardless of any non-forced refresh in flight.
    const stale = { ...baseCred, expiresAt: now + 30_000 };
    const externallyRefreshed: OAuthCredential = {
      ...baseCred,
      accessToken: "sk-ant-oat01-EXTERNAL",
      refreshToken: "sk-ant-ort01-EXTERNAL",
      expiresAt: now + 8 * 3_600_000,
    };
    const trulyForced: OAuthCredential = {
      ...baseCred,
      accessToken: "sk-ant-oat01-FORCED",
      refreshToken: "sk-ant-ort01-FORCED",
      expiresAt: now + 8 * 3_600_000,
    };
    let calls = 0;
    const store: CredentialStore = {
      read: vi.fn(async () => (calls++ === 0 ? stale : externallyRefreshed)),
      write: vi.fn(async () => {}),
    };
    const refresher: RefreshClient = {
      refresh: vi.fn(async () => trulyForced),
    };
    const tm = new TokenManager(store, refresher, noopLock(), clock);

    const [, b] = await Promise.all([
      tm.getAccessToken(),     // non-forced — may abandon via re-read
      tm.forceRefresh(),        // forced — must actually call refresher.refresh
    ]);
    // forceRefresh's returned token must be the one refresher produced
    // (not the abandoned re-read result).
    expect(b).toBe("sk-ant-oat01-FORCED");
    expect(refresher.refresh).toHaveBeenCalled();
  });
});
