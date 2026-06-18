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
    p.markCooldown("b@y", "opus", NOW +  5 * 60_000);
    p.markCooldown("c@z", "opus", NOW + 15 * 60_000);
    const pick = await p.pickToken("opus");
    expect(pick.acctId).toBe("b@y");
  });

  it("never picks an excluded account, even in the all-cooled fallback", async () => {
    const p = new AccountPool([A, B], { clock });
    p.markCooldown("a@x", "opus", NOW +  1 * 60_000);
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
