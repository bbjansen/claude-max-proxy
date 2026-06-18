# Self-owned OAuth credentials for the proxy agent

**Date:** 2026-06-18
**Status:** Approved (design)

## Problem

The agent currently reads its OAuth credentials from the macOS Keychain
entries that the Claude Code CLI writes under service
`Claude Code-credentials`. When interactive Claude Code runs on the same
Mac, both processes share the credential lifecycle:

- Refresh tokens rotate on every use.
- When the proxy refreshes, the Claude Code CLI's cached pair is now
  dead. Its next refresh fails with `invalid_grant` and the CLI prompts
  for re-login.
- The proxy includes a 5s `KeychainWatcher` + file lock + a
  `TokenManager.adoptExternalCredential` mitigation, but those mitigate
  the race rather than eliminating it. Over days of mixed interactive +
  proxy use, an operator-visible re-login is likely.

The fix is structural: have the proxy own its credentials end-to-end.
Run a one-time OAuth (PKCE) flow per account, store tokens under a
distinct Keychain service, and never share rotation state with the
Claude Code CLI.

## Goals

1. The proxy stores its credentials under a service name (`claude-max-proxy-credentials`) that the Claude Code CLI does not touch.
2. Adding a new account requires running `agent login [--acct <email>]` once; the flow opens a browser, completes PKCE, writes tokens.
3. Existing users with four accounts already captured under `Claude Code-credentials` migrate without re-logging in: a one-shot copy on first start populates the new service.
4. After migration, interactive Claude Code and the proxy share zero credential state. Refresh chains are independent.
5. Implementation removes net code: the watcher/file-lock/adopt subsystem stays for tests but is unnecessary in steady state.

## Non-Goals

- Token revocation on logout (Anthropic OAuth has no useful revoke endpoint for us).
- A REST `agent logout` command. `security delete-generic-password -s claude-max-proxy-credentials -a <email>` does the same thing.
- Deleting entries from `Claude Code-credentials` after migration; those belong to Claude Code and stay intact.
- Removing `KeychainWatcher` or `adoptExternalCredential` (kept; harmless, useful for tests, and a one-line dead-path is cheaper than the refactor).

## Architecture

```
                                                         ┌──────────────────────────┐
   ┌─────────────────┐         (zero contact)            │ Interactive Claude Code  │
   │ Proxy agent     │◀───────────────────────────────── │ keychain service:        │
   └────────┬────────┘                                   │   "Claude Code-credentials"│
            │                                            └──────────────────────────┘
            │ keychain service: "claude-max-proxy-credentials"
            ▼
   ┌─────────────────────────────┐
   │ KeychainStore               │
   └────────────┬────────────────┘
                │
                ▼
   ┌──────────────────────────────┐
   │ PKCE OAuthClient             │
   │   one-shot localhost callback│
   │   exchanges code → tokens     │
   └──────────────────────────────┘
```

## Components

### Constants

- `agent/src/tokens.ts:9` — `KEYCHAIN_SERVICE = "claude-max-proxy-credentials"`.
- `agent/src/index.ts:19` — same constant, used by the enumerator's regex and the empty-pool error message.

### `agent/src/oauth.ts` (new)

Pure-function PKCE primitives.

```ts
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const SCOPES = "user:inference user:profile user:mcp_servers user:file_upload user:sessions:claude_code";

export interface PkcePair { verifier: string; challenge: string; }
export function generatePkcePair(): PkcePair;
export function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string;
export interface CodeExchangeResult extends OAuthCredential {}
export async function exchangeCodeForTokens(code: string, verifier: string, redirectUri: string): Promise<CodeExchangeResult>;

export interface CallbackResult { code: string; state: string; }
export async function runLocalCallbackServer(expectedState: string, port?: number): Promise<{ result: Promise<CallbackResult>; redirectUri: string; close: () => void }>;
```

- `generatePkcePair`: 64-char URL-safe-base64 verifier from `crypto.randomBytes(48)`. Challenge = `base64url(sha256(verifier))`.
- `buildAuthorizeUrl`: standard `URLSearchParams`. `code_challenge_method=S256`, `response_type=code`.
- `runLocalCallbackServer`: `node:http` server on `127.0.0.1` with `port=0` (random). Responds to `/callback?code=…&state=…` with HTML "you can close this tab"; rejects other paths with 404. Resolves the result promise on the first valid callback, then closes itself.
- `exchangeCodeForTokens`: POST JSON form `{grant_type: "authorization_code", code, code_verifier, client_id, redirect_uri}`. Maps response to the existing `OAuthCredential` shape (the same one `PlatformRefreshClient.refresh` returns).

### `agent/src/login.ts` (new)

```ts
export interface LoginDeps {
  openBrowser?: (url: string) => Promise<void>;
  writeCredential?: (acctId: AccountId, cred: OAuthCredential) => Promise<void>;
  log?: (msg: string) => void;
}
export async function runLogin(acctId: AccountId, deps?: LoginDeps): Promise<void>;
```

Orchestration:

1. Generate PKCE pair, state.
2. Start callback server (port 0), capture chosen port and redirect URI.
3. Build authorize URL. Open with `openBrowser` (defaults to `spawn("open", [url])` on macOS; fallback prints URL to stderr).
4. Await the callback. Reject on state mismatch.
5. Exchange code for tokens.
6. Write to Keychain via `KeychainStore(acctId).write(cred)`.

### `agent/src/migrate.ts` (new)

One-shot copy from the old shared service into the new self-owned service. Idempotent.

```ts
export interface MigrateDeps {
  listOld: () => Promise<AccountId[]>;
  readOld: (acctId: AccountId) => Promise<OAuthCredential | null>;
  listNew: () => Promise<AccountId[]>;
  writeNew: (acctId: AccountId, cred: OAuthCredential) => Promise<void>;
  log?: (msg: string) => void;
}
export async function runMigrationOnce(deps: MigrateDeps): Promise<{ migrated: number; skipped: string[] }>;
```

Behavior:

- If `listNew()` returns ≥1 entry, return `{ migrated: 0, skipped: [] }` immediately.
- Otherwise for each `acctId` in `listOld()`:
  - `readOld(acctId)` → if `null` or malformed, push onto `skipped`, continue.
  - `writeNew(acctId, cred)`.
- Log `[agent] migrated <n> credentials from "Claude Code-credentials" to "claude-max-proxy-credentials"; skipped <names>`.

### Subcommand dispatch in `agent/src/index.ts`

```
agent                      → existing server behavior (run pool + watcher + listen)
agent login [--acct EMAIL] → runLogin(EMAIL or prompt)
agent migrate              → forces runMigrationOnce; useful if startup migration was skipped
```

On the `agent` (no-args) path, `main()` runs `runMigrationOnce` BEFORE the first watcher tick. The watcher tick then enumerates the new service and finds the just-copied entries.

The `--acct` flag of `login` accepts an arbitrary string (validated to look like an email: `^[^\s@]+@[^\s@]+\.[^\s@]+$`); if omitted, the flow completes the OAuth handshake first, then reads the account email from the access token's `sub` claim (the OAuth response includes a JWT-shaped access token where the subject is the account email).

### Watcher and TokenManager unchanged

- `KeychainWatcher` keeps watching `claude-max-proxy-credentials`. Its `adoptExternalCredential` branch is effectively dead (no peer writes), kept for symmetry and cheap testability.
- `TokenManager` is unchanged.

## Data flow — first startup after upgrade

1. `main()` runs `runMigrationOnce`. The new service is empty; the old service has the four captured entries.
2. Each is copied: `(service="claude-max-proxy-credentials", account="bob.jansen@pm.me", payload=<unchanged JSON>)`, etc.
3. First `watcher.tick()` enumerates the new service, builds 4 `TokenManager`s, populates the pool.
4. Server listens. Logs show `migrated 4 credentials …`.
5. Future refreshes write only to the new service.
6. Claude Code CLI keeps reading/writing its own old service. The two no longer interact.

## Data flow — `agent login --acct bob@new.com`

1. PKCE pair + 32-char state generated.
2. Local callback server starts on `127.0.0.1:<random>`. Redirect URI is `http://127.0.0.1:<port>/callback`.
3. Authorize URL built. `spawn("open", [url])` opens the user's default browser.
4. User signs in to Anthropic. Redirect lands on the local server.
5. Server validates state, captures code, returns "Login successful — you can close this tab", exits.
6. `exchangeCodeForTokens(code, verifier, redirectUri)` POSTs to `platform.claude.com/v1/oauth/token` and returns an `OAuthCredential`.
7. `KeychainStore("bob@new.com").write(cred)`.
8. Running agent's watcher picks up the new entry within 5s.

## Error handling

| Failure | Behavior |
|---|---|
| State mismatch on callback | Server responds `400 Bad Request` with `OAuth state mismatch`. `runLogin` rejects with a `LoginError`. Exit code 2. No Keychain write. |
| Code exchange returns 4xx | Print upstream error verbatim, reject. Exit code 2. No Keychain write. |
| User aborts (Ctrl-C) during login | `SIGINT` handler closes the callback server and exits 130. |
| `open` command unavailable | `runLogin` falls back to printing the URL and waits for the callback. |
| Migration: source entry malformed JSON | Skip, log warn naming the account, continue. |
| Migration: target entry already exists | `addGenericPassword -U` updates; net effect: copy succeeds. (Reachable only if `listNew()` returned empty but a write race produced an entry; harmless.) |
| Migration runs after a successful prior run | `listNew()` is non-empty → return `{ migrated: 0 }`. No-op. |
| Pool empty after migration (old service was also empty) | Same error as today: `no Max-account Keychain entries discovered under service 'claude-max-proxy-credentials'`. Operator runs `agent login` once. |

## Testing

- **`oauth.test.ts`**
  - `generatePkcePair`: verifier length 64, base64url charset; challenge = base64url(sha256(verifier)).
  - `buildAuthorizeUrl`: contains `client_id`, `code_challenge_method=S256`, `response_type=code`, `scope` matches expected, `redirect_uri` and `state` round-trip.
  - `exchangeCodeForTokens` (fetch mocked): success → `OAuthCredential` shape with `expiresAt` ≈ `Date.now() + expires_in * 1000`; 4xx → throws with status + body.
  - `runLocalCallbackServer`: posts `/callback?code=…&state=expected` resolves the promise; state mismatch returns 400 and rejects.
- **`login.test.ts`**
  - Inject `runLocalCallbackServer` stub, `openBrowser` stub that triggers a fake redirect, mocked `exchangeCodeForTokens`. Assert the writeCredential dependency is called with the right account + tokens.
  - Reject path: callback resolves with wrong state → no write.
- **`migrate.test.ts`**
  - Empty new + 4 entries old → migrated 4, skipped 0.
  - Non-empty new → migrated 0, skipped 0.
  - 4 entries old but one returns `null` from `readOld` → migrated 3, skipped 1.
- **No real Anthropic in CI**; no real Keychain access. All shells / fetches injected.

## Project layout

```
agent/
├── src/
│   ├── oauth.ts        # NEW
│   ├── login.ts        # NEW
│   ├── migrate.ts      # NEW
│   ├── tokens.ts       # CHANGE (KEYCHAIN_SERVICE)
│   └── index.ts        # CHANGE (subcommand dispatch + KEYCHAIN_SERVICE)
└── test/
    ├── oauth.test.ts   # NEW
    ├── login.test.ts   # NEW
    └── migrate.test.ts # NEW
docs/operations/capturing-multi-account-credentials.md   # REWRITE
```

The operations guide is rewritten to describe `agent login` instead of the `claude logout && claude && scripts/capture-max-account.sh` dance. The old `scripts/capture-max-account.sh` stays in the repo as a vestigial helper for anyone on an older agent build (it still works against the old service).

## Configuration & secrets

- `KEYCHAIN_SERVICE` is now `claude-max-proxy-credentials`. No env-var override (configurable would be a footgun).
- OAuth `client_id` `9d1c250a-…`, `AUTHORIZE_URL`, `TOKEN_URL`, scopes — all hardcoded constants in `oauth.ts`. Identical to what Claude Code uses.
- The agent runs as the user's login session (existing launchd plist) so the Keychain partition list already permits the `security` shell-outs. No new permissions.

## Risks & Mitigations

1. **PKCE flow ergonomics on a headless Mac (SSH session)** — `open` fails. *Mitigation:* fallback prints the URL; user opens it on whatever machine has a browser; redirect still hits `127.0.0.1` on the agent's host (won't reach the laptop). For SSH use the operator must `ssh -L <port>:127.0.0.1:<port>` first. Documented in the ops guide.
2. **Migration runs before the Keychain partition list permits the write** — first launchd run after upgrade may prompt. *Mitigation:* `security add-generic-password -U` runs under the user's session; first prompt grants access; subsequent calls inherit the ACL.
3. **Refresh-token-rotation race with peer processes on the SAME service** — multiple instances of the agent on one Mac, or future agents on multiple Macs sharing a Keychain (not in scope). *Mitigation:* the existing `~/.claude/.proxy-refresh.lock` file lock still serialises refresh across instances of the agent itself. Same as today.
4. **First migration runs simultaneously with watcher tick** — if migration is async and the tick fires before it finishes, the pool starts empty. *Mitigation:* migration is awaited synchronously in `main()` before `watcher.tick()`. Same ordering as the current single-account credential check.
5. **Agent's OAuth scopes drift from Claude Code's** — if Anthropic adds a required scope, our cached tokens may stop working. *Mitigation:* same risk as the current shared-Keychain design (we read tokens Claude Code minted). After this change we mint our own with the same scope set; if the scope list ever changes upstream, a new `agent login` per account is the cure.
6. **PKCE state replay** — an attacker who can read your local network sees the callback URL and racing to redeem the code. *Mitigation:* state is single-use; server validates and exits after first callback. Code is also single-use per Anthropic's OAuth contract.

## Open questions

None at design time. Implementation may surface small details (whether the access token actually contains the email as `sub`, whether `open` needs a `-g` flag to background) that the plan resolves.
