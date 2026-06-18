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
