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
    const body = await res.json() as { now_ms: number; accounts: Array<{ acct_id: string; manually_disabled: boolean; cooldown: Record<string, { until_ms: number; remaining_s: number } | null> }> };
    expect(body.now_ms).toBe(NOW);
    const a = body.accounts.find((x) => x.acct_id === "a@x")!;
    expect(a.cooldown.opus).toEqual({ until_ms: NOW + 5 * 60_000, remaining_s: 300 });
    expect(a.cooldown.haiku).toBeNull();
    expect(a.manually_disabled).toBe(false);
    const b = body.accounts.find((x) => x.acct_id === "b@y")!;
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
