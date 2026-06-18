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
