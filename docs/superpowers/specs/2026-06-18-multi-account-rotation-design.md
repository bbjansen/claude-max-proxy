# Multi-account rotation for the claude-max-proxy agent

**Date:** 2026-06-18
**Status:** Approved (design)

## Problem

The agent currently reads a single OAuth credential from macOS Keychain
(`Claude Code-credentials` / login-user account) and forwards every
`/v1/messages` request to `api.anthropic.com` on its behalf. The Max plan
that backs this proxy has per-account, per-model rate windows of roughly
five hours. With a single account, Opus and Sonnet calls hit
`rate_limit_error` after a small burst and the proxy returns 429 until the
window rolls.

The user holds four Max subscriptions
(`bob.jansen@pm.me`, `bob.jansen@wearetriple.com`, `bob@topolab.nl`,
`support@topolab.nl`). The combined quota across all four would carry
ordinary load comfortably. This spec adds an account pool with load
balancing and per-tier failover so the agent presents one logical surface
backed by every available account.

## Goals

1. Spread normal traffic across all discovered Max accounts using a
   round-robin selector — combined quota ceiling is the union of all
   accounts.
2. When an account returns `429 rate_limit_error` for a model tier, mark
   that `(account, tier)` pair as cooled-down and route future requests
   for that tier away from it until the cooldown expires.
3. Recover automatically: when Anthropic sends `retry-after`, use it; in
   its absence default to a 5-minute cooldown.
4. Pick up account additions and removals at runtime — the agent does not
   need to restart when a new Keychain entry is captured.
5. Pick up external OAuth refreshes — when interactive Claude Code rotates
   one of the same accounts, the agent should see the new token within a
   few seconds without forcing its own refresh.
6. Behavior is observable: every request logs which account served it,
   and an admin HTTP surface exposes the pool's current state and lets
   the operator manually disable / re-enable an account.

## Non-Goals

- Multi-process, multi-machine pool coordination. State is in-memory,
  one process, one Mac.
- Cooldown persistence across agent restarts. A restart is cheap and the
  cooldown will re-trigger on the next 429.
- Per-tier-dedicated accounts (e.g. "use account A only for Opus"). The
  round-robin + cooldown shape already handles this dynamically.
- Anthropic concurrency limits per account beyond the rate window. Not
  exposed by the API.

## Architecture

```
                  POST /v1/messages (body carries `model`)
                                │
                                ▼
   ┌──────────────────────────────────────────────────┐
   │ Agent HTTP server (existing)                     │
   │   • parse body, derive modelTier                 │
   └──────────────────┬───────────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────────┐
   │ AccountPool                                      │
   │   • pickToken(tier, exclude?) → {acctId, token}  │
   │   • markCooldown(acctId, tier, untilMs)          │
   │   • accounts(): AccountId[]                      │
   │   • cooldown: Map<acctId, Map<tier, untilMs>>    │
   │   • managers: Map<acctId, TokenManager>          │
   └──────────────────┬───────────────────────────────┘
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
  ┌─────────┐    ┌─────────┐    ┌─────────┐
  │ TM #1   │    │ TM #2   │    │ TM #N   │
  │ acct=A  │    │ acct=B  │    │ acct=…  │
  │ Keychain│    │ Keychain│    │ Keychain│
  └─────────┘    └─────────┘    └─────────┘
       ▲              ▲              ▲
       └──────────────┼──────────────┘
                      │
   ┌──────────────────────────────────────────────────┐
   │ KeychainWatcher (5s tick)                        │
   │   • lists Keychain entries → updates pool roster │
   │   • re-reads each account's credential JSON      │
   │   • if `expiresAt` newer → swaps cache w/o       │
   │     triggering an upstream OAuth refresh         │
   └──────────────────────────────────────────────────┘
```

Anthropic-bound egress still happens from the Mac's residential IP. The
Worker, Tunnel, and inbound auth are untouched.

## Components

### AccountId

Type alias `AccountId = string`, the Keychain `acct` field for the entry
(an email address such as `bob.jansen@pm.me`). Unique per Max account.

### TokenManager (existing — modified surface)

Already takes a `store` and `refresher` in the constructor. The only
change is to expose one additional method:

```ts
adoptExternalCredential(cred: OAuthCredential): void;
```

It atomically swaps the in-memory cache to `cred` without acquiring the
file lock or calling the upstream refresh. Used by KeychainWatcher when a
peer process (interactive Claude Code) rotated the token.

`getAccessToken()` and `forceRefresh()` keep their current semantics.

### KeychainStore (existing — no protocol changes)

Already accepts an `account` constructor argument. The proxy now passes
each Max-account email explicitly instead of defaulting to the macOS
login user. The atomic write-back path is unchanged; rotated refresh
tokens are written back under the same account name.

### AccountPool (new)

Owns the N TokenManagers and the cooldown map.

```ts
class AccountPool {
  constructor(initial: TokenManager[]);
  pickToken(tier: ModelTier, exclude?: AccountId[]): Promise<{acctId: AccountId, token: string}>;
  markCooldown(acctId: AccountId, tier: ModelTier, untilMs: number): void;
  upsertAccount(acctId: AccountId, tm: TokenManager): void;
  removeAccount(acctId: AccountId): void;
  accounts(): AccountId[];
  cooldownSnapshot(): Record<AccountId, Record<ModelTier, number>>;
}
```

Internal state:

- `managers: Map<AccountId, TokenManager>` — insertion-ordered.
- `nextIdx: number` — round-robin cursor, modulo `managers.size`.
- `cooldown: Map<AccountId, Map<ModelTier, number>>` — `untilMs` epoch ms.

### Selector

`pickToken(tier, exclude=[])` scans up to `managers.size` slots starting
from `nextIdx`. For each candidate it skips:

- accounts present in `exclude`, and
- accounts whose `cooldown[acctId][tier] > now`.

The first candidate that passes is the chosen account; `nextIdx` advances
to the slot after it. Its TokenManager produces the access token via
`getAccessToken()`.

If every candidate fails the predicates, the selector picks the
non-excluded account with the soonest-expiring cooldown for the tier and
returns it anyway (better to fail loud with a real upstream 429 than to
swallow the request internally).

### Cooldown

```ts
type ModelTier = "opus" | "sonnet" | "haiku" | "other";
```

`modelTierOf(modelString)`:

- prefix `claude-opus-*` → `opus`
- prefix `claude-sonnet-*` → `sonnet`
- prefix `claude-haiku-*` → `haiku`
- anything else → `other`

On `429` with response body `error.type == "rate_limit_error"`:

- `markCooldown(acctId, tier, now + retryAfterMs(response))`
- `retryAfterMs(response)`: parse `retry-after` header. If integer
  seconds → `seconds * 1000`. If HTTP-date → `(date - now)` clamped to
  `[0, 60*60*1000]`. If missing or malformed → `5 * 60 * 1000` (5 min).

The cooldown map only holds tiers that have actually been rate-limited; an
account with no `cooldown` entries for the requested tier is treated as
fully available.

### KeychainWatcher

Background `setInterval(5_000)` (cancellable). Each tick:

1. Enumerate Keychain entries: shell out to `security` with a filter on
   `svce="Claude Code-credentials"`. Extract every distinct `acct` value.
2. Reconcile against `AccountPool.accounts()`:
   - For each newly seen account: build `TokenManager(new KeychainStore(acctId), refresher, lock)` and call `pool.upsertAccount(acctId, tm)`.
   - For each account no longer seen: `pool.removeAccount(acctId)` and tear down the manager.
3. For each existing account: `security find-generic-password -a <acctId> -w` (parsed value compared by `expiresAt`). If the parsed credential's `expiresAt` is strictly greater than the TokenManager's cached value, call `tm.adoptExternalCredential(cred)`.

Failures inside the tick are logged at warn level and never throw out of
the tick — the watcher keeps running.

### Admin HTTP endpoint

A small read-mostly surface on the same agent server, gated by the same
auth as `/v1/messages` (the Worker validates the bearer / Access JWT;
the agent trusts the Tunnel). Routes:

| Method | Path | Behavior |
|---|---|---|
| `GET`  | `/v1/admin/accounts` | Returns the pool snapshot (see shape below). |
| `POST` | `/v1/admin/accounts/{acctId}/disable` | Sets `manuallyDisabled[acctId] = true`. Selector skips the account on every tier until re-enabled. Body optional `{"reason": string}` logged. |
| `POST` | `/v1/admin/accounts/{acctId}/enable` | Clears `manuallyDisabled[acctId]`. Does not touch cooldown — that expires on its own clock. |

Snapshot shape (`GET /v1/admin/accounts`):

```json
{
  "now_ms": 1781750000000,
  "accounts": [
    {
      "acct_id": "bob.jansen@pm.me",
      "manually_disabled": false,
      "cooldown": {
        "opus":   { "until_ms": 1781751800000, "remaining_s": 1800 },
        "sonnet": null,
        "haiku":  null,
        "other":  null
      },
      "last_used_ms": 1781749900000,
      "credential_expires_at_ms": 1781760000000
    },
    {
      "acct_id": "bob@topolab.nl",
      "manually_disabled": true,
      "cooldown": { "opus": null, "sonnet": null, "haiku": null, "other": null },
      "last_used_ms": null,
      "credential_expires_at_ms": 1781800000000
    }
  ]
}
```

The selector treats `manuallyDisabled[acctId] === true` the same way as
"cooled for every tier": skip during the round-robin scan, fall through
to the in-cooldown-but-not-disabled fallback if every other account is
also unavailable. A manually disabled account is *never* picked for a
fallback attempt.

Implementation note: `last_used_ms` and `manuallyDisabled` live on
`AccountPool` alongside the cooldown map; both are in-memory and reset on
restart (matching the rest of the pool's state).

### Configuration

- **Auto-discovery** is the default. The KeychainWatcher seeds the pool on
  its first tick and keeps it in sync afterward.
- **Override** via env var: `CLAUDE_MAX_ACCOUNTS="a@x,b@y,c@z"`. When
  set, the pool is restricted to the listed account IDs; unlisted ones
  discovered by the watcher are ignored. Useful for testing or
  temporarily routing around a known-broken account without deleting it
  from Keychain.
- **Defaults:** refresh threshold and file-lock path stay the same as the
  current single-account agent.

## Data flow — request

1. Client `POST /v1/messages` arrives at agent server (existing path).
2. Server parses request body to extract `model` and derives the tier
   via `modelTierOf(model)`.
3. `pool.pickToken(tier)` returns `{acctId, token}`.
4. `callUpstream(body, accept, token)` POSTs to
   `https://api.anthropic.com/v1/messages` with the same OAuth headers
   as today (`Authorization: Bearer <token>` plus the
   `anthropic-beta: oauth-2025-04-20,claude-code-20250219` header pair).
5. On `200`: pass response through. Log `{requestId, acctId, model, status=200}`.
6. On `429` with `rate_limit_error`:
   - `pool.markCooldown(acctId, tier, now + retryAfterMs(response))`.
   - `pool.pickToken(tier, exclude=[acctId])` → second candidate.
   - Re-issue the same body to upstream with the second account's token.
   - Up to **3 total attempts** (i.e. up to 2 failovers). After the third,
     forward the upstream 429 to the client and log
     `{requestId, attempts=3, status=429}`.
7. On other errors (4xx not 429, 5xx): forward verbatim, no cooldown
   change. The 401-re-read-then-refresh-then-retry path inside `TokenManager`
   is unchanged.

## Error handling

| Failure | Behavior |
|---|---|
| All accounts cooled for the requested tier | Selector picks the soonest-expiring one anyway. Upstream will likely 429 again; after 3 attempts the client sees a 429 with `error.message="all configured accounts are rate-limited for tier X"`. |
| Refresh chain dead on one account (`invalid_grant`) | TokenManager surfaces the existing 401-with-`refresh_failed`. AccountPool catches it and marks the account cooled-down for *all* tiers for 24 hours. Next call to `pickToken` skips it. Other accounts continue serving. |
| Keychain entry missing or malformed for a known account | KeychainWatcher logs warn and `removeAccount(acctId)`. Pool continues with the remainder. |
| Pool empty at startup | Agent fails to start with a clear message: `"no Max-account Keychain entries discovered under service 'Claude Code-credentials'; capture at least one (see docs/operations/capturing-multi-account-credentials.md)"`. |
| KeychainWatcher tick throws | Log at warn, continue. The next tick re-attempts. |
| Concurrent `pickToken` and `markCooldown` | Both are synchronous against in-memory maps; Node's single-thread model rules out a true race. |

## Testing

- **AccountPool unit** — mock TokenManagers (return canned tokens), fake
  clock. Cover:
  - Round-robin order with no cooldowns.
  - Skip a cooled account for the requested tier; non-requested tiers still selectable for that account.
  - All-cooled-for-tier fallback picks soonest-expiring.
  - `exclude` parameter blocks the listed account.
  - `upsertAccount` / `removeAccount` mutate the pool atomically; concurrent `pickToken` immediately after sees the new shape.
- **Selector** — table-driven across cooldown matrices.
- **Cooldown extraction** — `retry-after: 60`, `retry-after: <http-date>`,
  missing header, malformed header, header clamped to 1h.
- **Tier extraction** — table-driven model→tier map including the four
  known model prefixes plus an unknown model (→ `other`).
- **KeychainWatcher** — mock `security` shell with scripted outputs:
  newly-discovered account, removed account, externally-refreshed token
  (newer `expiresAt`). Use a fake clock so the 5s tick is deterministic.
- **TokenManager.adoptExternalCredential** — verify cache swap, verify it
  does NOT trigger an upstream refresh, verify subsequent `getAccessToken`
  returns the new token.
- **Integration (mocked Anthropic)** — agent end-to-end with two
  TokenManagers and a fake upstream that returns 429 on the first call
  and 200 on the second. Verify the client sees the 200 response and the
  cooldown was recorded.
- **Admin endpoint** — exercise `GET /v1/admin/accounts` against a pool
  with mixed states (one cooled, one disabled, one healthy) and assert
  the response shape. Exercise `POST .../disable` and verify the next
  `pickToken` skips it; exercise `POST .../enable` and verify
  selectability returns.

## Project layout

```
agent/
├── src/
│   ├── tokens.ts              # existing, plus adoptExternalCredential()
│   ├── pool.ts                # AccountPool + Selector + cooldown + manuallyDisabled
│   ├── tier.ts                # modelTierOf + retryAfterMs
│   ├── watcher.ts             # KeychainWatcher (5s tick)
│   ├── upstream.ts            # uses pool.pickToken + failover
│   ├── server.ts              # parses model from body, routes /v1/messages + /v1/admin/accounts
│   ├── admin.ts               # admin handlers: snapshot, disable, enable
│   ├── index.ts               # constructs pool + watcher
│   └── types.ts
└── test/
    ├── tokens.test.ts         # extended with adoptExternalCredential
    ├── pool.test.ts           # new
    ├── tier.test.ts           # new
    ├── watcher.test.ts        # new
    ├── admin.test.ts          # new
    └── upstream.test.ts       # extended with failover
docs/operations/capturing-multi-account-credentials.md   # new operational guide
scripts/capture-max-account.sh                            # new helper for the renaming dance
```

## Configuration & secrets

- No new secrets. Each Max account contributes one Keychain entry whose
  payload is the OAuth credential JSON produced by `claude` login.
- `CLAUDE_MAX_ACCOUNTS` env var (optional, comma-separated allowlist).
- Existing refresh-token file lock path (`~/.claude/.proxy-refresh.lock`)
  serves all accounts — they take turns acquiring it. (Each refresh is
  short, and contention is rare; the per-account in-process mutex inside
  TokenManager already prevents in-process concurrent refresh.)

## Risks & Mitigations

1. **One file lock for all accounts** — under bursty refresh load with
   four accounts, two accounts could contend on the lock. *Mitigation:*
   acceptable; refreshes are sub-second and only happen near token expiry.
   If pathological, the lock filename could be per-account (e.g.
   `~/.claude/.proxy-refresh.<acctId>.lock`); deferred.
2. **Keychain enumeration cost** — `security dump-keychain` is slower than
   a single `find-generic-password`. *Mitigation:* the 5s tick is the only
   caller; cost is negligible at that cadence.
3. **Refresh token rotation across N accounts under interactive Claude
   Code load** — if the user runs Claude Code on the same machine against
   one of the proxied accounts, both processes contend on rotated refresh
   tokens. *Mitigation:* the KeychainWatcher picks up Claude Code's
   rotation; existing 401-retry-with-fresh-read in TokenManager covers the
   reverse case.
4. **Account list drift between accidental logouts and the watcher tick**
   — a 5s window where a missing account could be picked. *Mitigation:*
   pickToken's failover-on-401 path already handles a dead credential
   gracefully (it returns 401 to the client; client retries; by then the
   watcher has reconciled). Acceptable.
5. **Tier classification staleness** — Anthropic ships new model
   families. *Mitigation:* unknown models fall into `other` and share a
   single cooldown bucket. Harmless; update `modelTierOf` when a new
   family is added.
6. **Anthropic Max-plan ToS** — same gray area as the single-account
   proxy. *Mitigation:* unchanged; documented; single-user behind Access.

## Operational: capturing the four OAuth tokens

The default Claude Code login overwrites a single Keychain entry. To hold
four distinct entries:

1. Log out current Claude Code (`claude logout`).
2. `claude` → log in as account 2 → browser flow completes.
3. Run `scripts/capture-max-account.sh <new-acct-id>` which:
   - Reads the just-written entry (Keychain account = macOS login user).
   - Re-writes it under `acct=<new-acct-id>` (the Max-plan email).
   - Deletes the default-named entry.
4. Repeat for accounts 3 and 4.
5. KeychainWatcher's next tick (≤5s) picks up the four new entries.

The helper script is part of the implementation plan, not the design.

## Open questions

None at design time. Implementation will surface small details (exact
Keychain enumeration command syntax, the watcher's failure-budget for
spawn errors) that the plan resolves.
