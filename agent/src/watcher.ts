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
  private readonly known = new Map<AccountId, number>();
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

    for (const acctId of this.pool.accounts()) {
      if (!allowedSet.has(acctId)) {
        this.pool.removeAccount(acctId);
        this.known.delete(acctId);
      }
    }

    for (const acctId of this.pool.accounts()) {
      try {
        const cred = await this.enumerator.read(acctId);
        if (!cred) continue;
        const lastExp = this.known.get(acctId) ?? 0;
        if (cred.expiresAt > lastExp) {
          const mgr = this.pool.getManager(acctId);
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
