import { describe, it, expect } from "vitest";
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
