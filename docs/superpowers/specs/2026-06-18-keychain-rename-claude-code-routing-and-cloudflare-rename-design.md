# Keychain rename + Claude Code routing + Cloudflare live rename

**Date:** 2026-06-18
**Status:** Approved (design)

## Problem

Three related cleanups want to land together:

1. The agent's Keychain service is still named `claude-max-proxy-credentials`
   despite the project rename to `claudette`. The historical name leaks
   into specs, code, and admin logs.
2. The interactive Claude Code CLI on the operator's Mac runs against the
   stock Anthropic API and burns through a single Max account's quota.
   Routing it through the proxy distributes its requests across all four
   Max accounts.
3. The live Cloudflare deployment is still named `claude-max-proxy`
   (Worker, Tunnel, hostname). The previous public release intentionally
   deferred renaming the deployment to avoid an outage. The operator now
   wants the live names to match the public repo's name.

A single design covers all three because the Claude Code routing config
needs the final Cloudflare URL and the renamed Keychain service must
exist on the operator's machine before Claude Code starts routing
through it.

## Goals

1. Code references the Keychain service as `claudette-credentials`
   throughout. Migration chains preserve operator data with no re-login.
2. Interactive Claude Code on this Mac sends every request through the
   proxy at the new (renamed) Worker URL, pinning to one Max account per
   session so prompt caching stays warm.
3. Live Cloudflare deployment is renamed end-to-end (Worker, Tunnel,
   DNS, Access app, service token, PROXY_KEY rotation). Old resources
   torn down after the new chain is verified.
4. Process is blue/green: the new stack is stood up alongside the old,
   verified end-to-end, only then is the old torn down. ≤10 minutes of
   overlap where either URL works.

## Non-Goals

- A multi-tenant API for arbitrary external clients (still single-operator).
- Letting the user list/pick accounts via a Claude Code slash command.
- Auto-rotating the per-session pin when an account hits its quota.
- A REST endpoint for setting the X-Account-Hint server-side.
- Updating the public README's example URL (already a placeholder).

## Architecture

```
[ Claude Code CLI ]
       │
       │ x-api-key: <PROXY_KEY_v2>
       │ x-account-hint: bob.jansen@pm.me
       ▼
[ Cloudflare Worker "claudette" ]                claudette.bobjansen.workers.dev
       │ + x-account-hint passed through
       │ + service token to Access app
       ▼
[ Cloudflare Tunnel "claudette" ]                claudette-agent.bobjansen.dev
       │
       │ http://127.0.0.1:8787
       ▼
[ claudette agent ]                              ~/projects/claudette/agent
       │ X-Account-Hint → AccountPool.pickToken(tier, [], hint)
       │ pinned account's OAuth bearer
       ▼
[ api.anthropic.com/v1/messages ]
```

Resources renamed in lockstep. The "blue" copy (current
`claude-max-proxy.*`) stays online during the rename for fast rollback.

## Components

### 1. Keychain service rename

**`agent/src/tokens.ts:9`** — `KEYCHAIN_SERVICE = "claudette-credentials"`.

**`agent/src/index.ts:21`** — `NEW_SERVICE = "claudette-credentials"`.

**`agent/src/migrate.ts`** — Extended interface:

```ts
export interface MigrateDeps {
  listOld(): Promise<AccountId[]>;
  readOld(acctId: AccountId): Promise<OAuthCredential | null>;
  listNew(): Promise<AccountId[]>;
  writeNew(acctId: AccountId, cred: OAuthCredential): Promise<void>;
  log?(msg: string): void;
  // Secondary source consulted only when the primary returned zero
  // entries — for chained migrations across multiple historical
  // service names.
  secondaryListOld?(): Promise<AccountId[]>;
  secondaryReadOld?(acctId: AccountId): Promise<OAuthCredential | null>;
}
```

If `listNew()` returns ≥1 entry, no-op (idempotent). Else iterate
`listOld()`. If `listOld()` returned zero entries AND `secondaryListOld`
is defined, iterate the secondary source.

**`agent/src/index.ts`** — `migrateLegacyService()` now passes both
sources:

- primary: `Claude Code-credentials` (Claude Code CLI)
- secondary: `claude-max-proxy-credentials` (older agent build)

Order matters: the primary source is the canonical Claude Code CLI
location; the secondary is for operators who deployed the
`claude-max-proxy`-era agent.

**Spec doc text + ops doc** — every mention of
`claude-max-proxy-credentials` updated to `claudette-credentials`.

### 2. Claude Code routing — sticky-per-session X-Account-Hint

**`agent/src/pool.ts`** — `pickToken` signature extended:

```ts
pickToken(tier: ModelTier, exclude?: AccountId[], hint?: AccountId | null): Promise<{ acctId: AccountId; token: string }>
```

Selection logic when `hint` is set:

1. If `hint` is in `managers` AND not in `excludeSet` AND not in `disabled` AND `cooldown[hint][tier] ≤ now`: return it. (Does not advance `nextIdx`.)
2. Otherwise: fall through to the existing round-robin scan.

This is purely an additive preference — the hint never blocks a fallback.

**`agent/src/upstream.ts`** — `callUpstreamRotating` opts gain
`accountHint?: string`:

```ts
const { acctId, token } = await pool.pickToken(tier, tried, opts.accountHint ?? null);
```

The hint is applied on the FIRST attempt only. On 429 retry, the hint
is dropped (the cooled account is in `tried`; the hint would just be
ignored anyway, but we drop it explicitly so the failover treats the
remaining accounts uniformly).

**`agent/src/server.ts`** — extracts `x-account-hint` request header
(case-insensitive, single value), passes it as `opts.accountHint`:

```ts
const accountHint = pickHeader(req.headers["x-account-hint"]);
const upstream = await deps.upstream(body, accept, deps.pool, accountHint);
```

The `upstream` callback signature gains a fourth parameter.

**`worker/src/index.ts`** — `FORWARD_HEADERS` set grows to include
`x-account-hint`. Worker's `handleAnthropicMessages` passes it through
to the Tunnel like any other allowlisted header.

### 3. Cloudflare deployment rename — blue/green migration

#### 3a. Stand up the green (new) stack

1. **New Tunnel** via API:
   ```sh
   AID=64f75ad3008e37e68b03ebbedefc89ed
   TOKEN=$(cat ~/.claude-max-proxy.cf)
   SECRET=$(openssl rand -base64 32)
   RESP=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
     -H "content-type: application/json" \
     "https://api.cloudflare.com/client/v4/accounts/$AID/cfd_tunnel" \
     -d "{\"name\":\"claudette\",\"tunnel_secret\":\"$SECRET\",\"config_src\":\"local\"}")
   NEW_UUID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['id'])")
   ```
   Save credentials JSON to `~/.cloudflared/$NEW_UUID.json` in the
   `{AccountTag, TunnelID, TunnelName, TunnelSecret}` shape.

2. **New DNS CNAME** `claudette-agent.bobjansen.dev` → `$NEW_UUID.cfargotunnel.com`,
   proxied, TTL 1.

3. **Cloudflared config swap** — edit `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <NEW_UUID>
   credentials-file: /Users/bob.jansen/.cloudflared/<NEW_UUID>.json
   ingress:
     - hostname: claudette-agent.bobjansen.dev
       service: http://localhost:8787
     - service: http_status:404
   ```
   Boot out old launchd cloudflared (`com.bobjansen.cloudflared-claude`),
   install new `dev.claudette.cloudflared` plist (uses tunnel name
   `claudette`), bootstrap. Verify the tunnel registers in the
   Cloudflare dashboard.

4. **New CF Access app** for `claudette-agent.bobjansen.dev` with a new
   Service Auth policy. Capture the new AUD tag, team domain, client ID
   and client secret.

5. **New Worker** named `claudette`:
   - Generate fresh `PROXY_KEY_v2 = openssl rand -hex 32`; save to `~/.claudette.key` (mode 0600).
   - `wrangler.jsonc` `TUNNEL_HOSTNAME: claudette-agent.bobjansen.dev`,
     `ACCESS_TEAM_DOMAIN` set to operator's team subdomain.
   - Push secrets: `PROXY_KEY` = `$(cat ~/.claudette.key)`, `ACCESS_AUD`,
     `TUNNEL_ACCESS_CLIENT_ID`, `TUNNEL_ACCESS_CLIENT_SECRET` — all
     pointing at the NEW Access app.
   - `npx wrangler deploy` — published at `claudette.bobjansen.workers.dev`.

6. **Smoke test** through the new chain:
   ```sh
   PROXY_KEY=$(cat ~/.claudette.key)
   curl -sS -X POST https://claudette.bobjansen.workers.dev/v1/messages \
     -H "authorization: Bearer $PROXY_KEY" \
     -H "content-type: application/json" \
     -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"PONG"}]}'
   ```
   Expected: `"type":"message"`.

#### 3b. Switch Claude Code to the new Worker

7. Write `~/.claude/settings.json`:
   ```jsonc
   {
     "env": {
       "ANTHROPIC_BASE_URL": "https://claudette.bobjansen.workers.dev",
       "ANTHROPIC_API_KEY": "<contents of ~/.claudette.key>",
       "ANTHROPIC_CUSTOM_HEADERS": "X-Account-Hint: bob.jansen@pm.me"
     }
   }
   ```
   Quit any running Claude Code; next launch picks up the env block.

8. Verify by starting a fresh `claude` session and checking the agent's
   admin snapshot: only `bob.jansen@pm.me` has `last_used_ms` advanced
   during the Claude Code session.

   **Fallback if `ANTHROPIC_CUSTOM_HEADERS` isn't honored:** create
   `~/.local/bin/claude-pinned`:
   ```sh
   #!/usr/bin/env bash
   exec /opt/homebrew/bin/claude --settings '{"env":{"ANTHROPIC_BASE_URL":"https://claudette.bobjansen.workers.dev","ANTHROPIC_API_KEY":"'$(cat ~/.claudette.key)'","ANTHROPIC_CUSTOM_HEADERS":"X-Account-Hint: bob.jansen@pm.me"}}' "$@"
   ```
   Operator runs `claude-pinned` instead of `claude` for sessions they
   want pinned.

#### 3c. Tear down the blue (old) stack

9. `npx wrangler delete --name claude-max-proxy` (with confirmation).
10. Delete DNS CNAME `claude-agent.bobjansen.dev`.
11. Delete the old Tunnel via `DELETE /accounts/$AID/cfd_tunnel/$OLD_UUID`.
12. Delete old CF Access app + service token from the Zero Trust dashboard.
13. `rm ~/.claude-max-proxy.key`.
14. `rm ~/.cloudflared/<OLD_UUID>.json`.

## Data flow — pinned Claude Code session

1. User runs `claude` (or `claude-pinned` fallback).
2. Claude Code reads `~/.claude/settings.json`, sets `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`.
3. Claude Code POSTs to `https://claudette.bobjansen.workers.dev/v1/messages`
   with `x-api-key: <PROXY_KEY_v2>` + `x-account-hint: bob.jansen@pm.me`.
4. Worker verifies bearer/key, allowlist includes `x-account-hint`, forwards
   through Tunnel.
5. Tunnel delivers to `127.0.0.1:8787`.
6. Server extracts the hint, calls `callUpstreamRotating(body, accept, pool, { accountHint: "bob.jansen@pm.me", ... })`.
7. `pool.pickToken("haiku", [], "bob.jansen@pm.me")` returns that account's
   OAuth token (cooldown OK, not disabled).
8. Upstream call to Anthropic uses the pinned OAuth bearer; prompt cache
   stays warm.
9. On 429 from the pinned account: cooldown recorded; second attempt
   uses normal round-robin (hint already failed once → just exclude).

## Error handling

| Failure | Behavior |
|---|---|
| Hint names an unknown / disabled / cooled account | Fall through to round-robin. Log `[agent] hint not honored, falling back`. |
| Migration: primary (`Claude Code-credentials`) returns zero AND secondary returns zero | Pool starts empty; agent exits with the existing "no Max-account credentials" error. |
| Migration: primary populated and secondary populated | Only primary copied. Secondary is a fallback, not an extender. (Documented; idempotent on next run.) |
| Worker fails to forward `x-account-hint` (header stripped at edge) | Hint not in request at the agent → round-robin. Operator sees no per-session pinning. Detectable: admin snapshot shows multiple accounts servicing one Claude Code session. |
| Old Worker tear-down (Phase C step 9) fails (e.g., billing dispute) | New chain already works; old stays alive. No user impact. Operator retries. |
| New Access app misconfigured | Worker → Tunnel call returns 403 HTML; agent never sees the request. `wrangler tail` shows the error. Operator fixes the Access policy. |
| `ANTHROPIC_CUSTOM_HEADERS` ignored by Claude Code | Use `claude-pinned` wrapper. Documented in the plan. |

## Testing

**Pool (`pool.test.ts`)** — 4 new tests:

- Hint honored when valid account exists, not cooled, not disabled.
- Hint ignored (round-robin) when hinted account is cooled.
- Hint ignored when hinted account is manually disabled.
- Hint ignored when hinted account is unknown.

**Migrator (`migrate.test.ts`)** — 2 new tests:

- `secondaryListOld` consumed when primary returns empty.
- `secondaryListOld` ignored when primary has entries (no double-copy).

**Upstream (`upstream.test.ts`)** — 1 new test:

- `accountHint` opt is forwarded to `pool.pickToken` on first attempt and
  dropped on 429-failover retry.

**Server (`server.test.ts`)** — 1 new test:

- Server extracts `x-account-hint` from request and threads it through
  the upstream callback.

**Worker (`worker/test/index.test.ts`)** — 1 new test:

- `x-account-hint` is forwarded to the Tunnel (added to FORWARD_HEADERS).

**Live e2e** — after Phase A:

- Smoke through the new URL (done in Phase A step 6).
- Verify pinned Claude Code session hits only the pinned account (step 8).

## Project layout (delta)

```
agent/src/migrate.ts          (+ secondary source)
agent/src/pool.ts             (+ hint param + selection logic)
agent/src/upstream.ts         (+ accountHint opt; threaded through)
agent/src/server.ts           (+ x-account-hint extraction)
agent/src/tokens.ts           (KEYCHAIN_SERVICE constant)
agent/src/index.ts            (NEW_SERVICE constant; migrateLegacyService chains)
agent/test/migrate.test.ts    (+ 2 tests)
agent/test/pool.test.ts       (+ 4 tests)
agent/test/upstream.test.ts   (+ 1 test)
agent/test/server.test.ts     (+ 1 test)
worker/src/index.ts           (+ x-account-hint in FORWARD_HEADERS)
worker/test/index.test.ts     (+ 1 test)
docs/operations/capturing-multi-account-credentials.md
                              (claude-max-proxy-credentials → claudette-credentials)
README.md                     (any stray claude-max-proxy-credentials mentions → claudette-credentials)
```

No new files. No file deletes.

## Configuration & secrets

- `~/.claudette.key` (new): mode 0600, the rotated PROXY_KEY for the
  renamed Worker.
- `~/.claude-max-proxy.key` (old): retained until Phase C step 13 then
  deleted.
- `~/.claude-max-proxy.cf` (Cloudflare API token): keeps its name to
  avoid yet another rename; the file content is unchanged and the
  filename is private.
- New CF Access app produces a new AUD tag and a new service token; both
  saved as Worker secrets on the `claudette` Worker only.
- New cloudflared credentials JSON at `~/.cloudflared/<NEW_UUID>.json`.
- `~/.claude/settings.json` updated as shown above; original backed up
  to `~/.claude/settings.json.pre-claudette.bak`.

## Risks & Mitigations

1. **`ANTHROPIC_CUSTOM_HEADERS` may not be supported by Claude Code's
   SDK fork.** Fall back to the `claude-pinned` wrapper script
   (documented in the plan).
2. **Migration triggers a Keychain ACL prompt the first time the
   launchd agent writes to `claudette-credentials`.** This is the same
   one-time prompt we hit on the `claude-max-proxy-credentials` rename
   and was accepted. Should not repeat.
3. **Old Worker deletion strands any consumer with the old URL
   bookmarked** — currently only this Mac (Claude Code config) and the
   Discord chat. Both are owned by the operator.
4. **The Cloudflare API token may not have all the scopes needed for
   tunnel/DNS/Worker delete operations.** Mitigated: same token did
   create operations earlier in this session. Dashboard fallback
   documented in the plan.
5. **PROXY_KEY rotation invalidates any client that already cached the
   old key (e.g., nram).** Mitigated: nram's config will be updated as
   part of Phase B (one PUT to its admin API per slot using the new
   `~/.claudette.key`).

## Open questions

None at design time. Implementation may surface specifics (whether the
Cloudflare API allows in-place tunnel rename, the exact filename for
the new cloudflared launchd log) that the plan resolves.
