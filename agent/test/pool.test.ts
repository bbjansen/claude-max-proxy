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
    p.markCooldown("b@y", "opus", NOW + 30 * 60_000);
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

  it("getManager surfaces the TokenManager for KeychainWatcher", () => {
    const p = new AccountPool([A], { clock });
    expect(p.getManager("a@x")).toBe(A.manager);
    expect(p.getManager("missing@x")).toBeUndefined();
  });

  it("snapshot reflects cooldown, disabled flag, and last-used time", async () => {
    const p = new AccountPool([A, B], { clock });
    p.markCooldown("a@x", "opus", NOW + 5 * 60_000);
    p.setManuallyDisabled("b@y", true);
    await p.pickToken("haiku");
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
    await p.pickToken("opus", [], "c@z");
    const next = await p.pickToken("opus");
    expect(next.acctId).toBe("a@x");
  });

  it("ignores the hint when the hinted account is cooled for the tier", async () => {
    const p = new AccountPool([A, B, C], { clock });
    p.markCooldown("c@z", "opus", NOW + 60_000);
    const pick = await p.pickToken("opus", [], "c@z");
    expect(pick.acctId).toBe("a@x");
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
