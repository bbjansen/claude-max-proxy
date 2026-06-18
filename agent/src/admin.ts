import type { AccountPool, PoolSnapshot, AccountSnapshot } from "./pool.js";

export interface AdminDeps {
  pool: AccountPool;
}

export function handleAccountsSnapshot(deps: AdminDeps): Response {
  return json(200, wireSnapshot(deps.pool.snapshot()));
}

export function handleAccountsDisable(deps: AdminDeps, acctId: string, rawBody: string): Response {
  if (!deps.pool.accounts().includes(acctId)) return json(404, errBody("not_found", `no such account: ${acctId}`));
  let reason: string | undefined;
  if (rawBody.length > 0) {
    try {
      const parsed = JSON.parse(rawBody) as { reason?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
    } catch { /* ignore */ }
  }
  deps.pool.setManuallyDisabled(acctId, true);
  return json(200, { acct_id: acctId, manually_disabled: true, reason: reason ?? null });
}

export function handleAccountsEnable(deps: AdminDeps, acctId: string): Response {
  if (!deps.pool.accounts().includes(acctId)) return json(404, errBody("not_found", `no such account: ${acctId}`));
  deps.pool.setManuallyDisabled(acctId, false);
  return json(200, { acct_id: acctId, manually_disabled: false });
}

function wireSnapshot(snap: PoolSnapshot): Record<string, unknown> {
  return {
    now_ms: snap.nowMs,
    accounts: snap.accounts.map(wireAccount),
  };
}

function wireAccount(a: AccountSnapshot): Record<string, unknown> {
  const cooldown: Record<string, unknown> = {};
  for (const tier of ["opus", "sonnet", "haiku", "other"] as const) {
    const c = a.cooldown[tier];
    cooldown[tier] = c ? { until_ms: c.untilMs, remaining_s: c.remainingS } : null;
  }
  return {
    acct_id: a.acctId,
    manually_disabled: a.manuallyDisabled,
    cooldown,
    last_used_ms: a.lastUsedMs,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errBody(type: string, message: string): Record<string, unknown> {
  return { error: { type, message } };
}
