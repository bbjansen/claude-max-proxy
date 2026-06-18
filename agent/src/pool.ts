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

export const ALL_TIERS = TIERS;
