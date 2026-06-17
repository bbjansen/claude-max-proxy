# Claude Max OAuth → `/v1/messages` Proxy

**Date:** 2026-06-17
**Status:** Approved (design)

## Problem

The user holds a Claude Max consumer subscription (no Anthropic API key) and wants
to call Claude programmatically from arbitrary Anthropic-SDK-compatible clients
through a self-hosted endpoint that speaks the standard Anthropic
`POST /v1/messages` API. The endpoint must be authenticated (Cloudflare Access /
Zero Trust) and live behind a custom domain.

A Cloudflare Worker is the preferred edge component. Anthropic's WAF, however,
blocks OAuth refresh from datacenter IP ranges (including Cloudflare Workers),
which makes a pure-Worker design fragile. The accepted architecture therefore
splits ingress (Worker) from Anthropic-bound egress (a small agent running on
the user's Mac).

## Goals

1. Expose `POST /v1/messages` on a public, Access-protected hostname.
2. Forward requests verbatim — including streaming SSE responses — to
   `api.anthropic.com/v1/messages`, authenticated with the user's Claude Max
   OAuth tokens.
3. Refresh tokens on demand from the user's residential IP (not from Cloudflare's
   datacenter ranges) and persist rotated refresh tokens atomically.
4. Keep the agent and interactive Claude Code from invalidating each other's
   refresh tokens.
5. Personal use only — single account, Cloudflare Access SSO gate.

## Non-Goals

- Multi-account or multi-tenant operation.
- Translating to or from OpenAI `/v1/chat/completions` (Anthropic format end to
  end).
- Model routing or fan-out across backends.
- Persistent request logging, metrics, or audit storage beyond stdout and
  Workers logs.
- Automatic recovery from a fully-invalidated refresh token chain — manual
  `claude` re-login is the documented recovery path.

## Architecture

```
[ Anthropic SDK / OpenRouter-style client ]
         │ POST /v1/messages   (Cloudflare Access SSO or service token)
         ▼
[ Cloudflare Access (Zero Trust) ]
         │ + Cf-Access-Jwt-Assertion
         ▼
[ Cloudflare Worker  (TypeScript) ]
   - verify Access JWT (aud check, defense-in-depth)
   - strip hop-by-hop headers
   - fetch private Tunnel hostname, stream body through
         │ HTTPS over Cloudflare Tunnel
         ▼
[ cloudflared on Mac ]  → http://127.0.0.1:8787
         │
         ▼
[ Local Agent  (Node + TypeScript) ]
   - read OAuth tokens from macOS Keychain
   - refresh on demand against platform.claude.com (residential IP)
   - file-locked atomic write-back to Keychain
   - call api.anthropic.com/v1/messages with required OAuth headers
   - stream SSE response back
```

Egress to Anthropic happens from the user's residential IP, so the
datacenter-IP WAF block does not apply. The Worker is a thin authenticated
front door.

## Components

### Cloudflare Worker (`worker/`)

- TypeScript, deployed via `wrangler`.
- Single route: `POST /v1/messages`. All other paths → `404`.
- Validates the `Cf-Access-Jwt-Assertion` header against `ACCESS_AUD` and
  `ACCESS_TEAM_DOMAIN` (JWKS fetched from
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached in module
  scope).
- Forwards the request to `https://<TUNNEL_HOSTNAME>/v1/messages` with:
  - method `POST`
  - body streamed from the incoming `Request.body`
  - allowlisted headers passed through: `accept`, `content-type`,
    `anthropic-version`, `x-real-client-ip`
- Returns the upstream `Response` directly so Workers passes the streaming body
  through unchanged.
- Hop-by-hop headers (`host`, `connection`, `cf-*`, `authorization`,
  `cookie`) are stripped before forwarding.

**Config (wrangler secrets / vars):**

- `TUNNEL_HOSTNAME` — private hostname for the Mac agent.
- `ACCESS_AUD` — Cloudflare Access application AUD tag.
- `ACCESS_TEAM_DOMAIN` — e.g. `myteam.cloudflareaccess.com`.

### Cloudflare Tunnel (`cloudflared/`)

- One named tunnel, registered on the Mac.
- Routes `claude-agent.internal.<your-domain>` → `http://localhost:8787`.
- Runs as a launchd service via `cloudflared service install`.
- Tunnel hostname is fronted by a Cloudflare Access service-token policy that
  permits only the Worker's service principal — so the hostname alone is not
  enough to reach the agent.

### Local Agent (`agent/`)

TypeScript on Node 20+. Pure stdlib HTTP server (no framework needed for one
route).

**Files:**

- `src/server.ts` — HTTP listener on `127.0.0.1:8787`, single `POST /v1/messages`
  route. Translates Node request/response into the calls below.
- `src/tokens.ts` — Keychain I/O and refresh logic. Exports `getAccessToken()`,
  `forceRefresh()`.
- `src/upstream.ts` — calls `api.anthropic.com/v1/messages`, handles the
  401-retry policy, streams response back.
- `src/types.ts` — shared types.

**Token store (`tokens.ts`):**

- Reads Keychain via shell-out:
  `security find-generic-password -s "Claude Code-credentials" -w`
- Parses the JSON value; expects:
  ```json
  { "claudeAiOauth": {
      "accessToken": "sk-ant-oat01-…",
      "refreshToken": "sk-ant-ort01-…",
      "expiresAt": 1748276587173,
      "scopes": ["user:inference", "user:profile"]
  }}
  ```
  `expiresAt` is **milliseconds** since epoch. Keys are camelCase.
- Falls back to reading `~/.claude/.credentials.json` if the Keychain entry is
  absent (Linux/SSH parity for future portability).
- Caches the parsed credential in memory.
- **Refresh threshold:** if `expiresAt - now < 60_000ms`, refresh before the
  upstream call.
- **Refresh request:**
  - `POST https://platform.claude.com/v1/oauth/token`
  - JSON body:
    ```json
    { "grant_type": "refresh_token",
      "refresh_token": "<current refresh token>",
      "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }
    ```
- **Refresh response:** standard OAuth; persists the rotated `refresh_token`
  immediately (rotation-on-use — old refresh token is invalidated server-side
  the moment a new one is issued).
- **Atomic write-back:**
  1. Acquire an exclusive file lock on `~/.claude/.proxy-refresh.lock` via
     `proper-lockfile` (10s stale timeout, 250ms retry interval).
  2. Inside the lock, re-read the Keychain entry — Claude Code may have
     refreshed in parallel; if the re-read credential's
     `expiresAt - now >= 60_000ms`, abandon our refresh and use it.
  3. Otherwise, perform the refresh, then write the new credential back via
     `security add-generic-password -U -s "Claude Code-credentials" \
      -a "<login user>" -w "<json>"`.
  4. Release the lock.
- **In-process Promise mutex** so multiple concurrent in-flight requests share
  a single refresh attempt.

**Upstream call (`upstream.ts`):**

- `POST https://api.anthropic.com/v1/messages`.
- Headers:
  - `Authorization: Bearer <access_token>`
  - `anthropic-beta: oauth-2025-04-20,claude-code-20250219`
  - `anthropic-version: 2023-06-01`
  - `x-app: cli`
  - `content-type: application/json`
  - `user-agent: claude-max-proxy/0.1`
  - `accept` passed through from the client (so `text/event-stream` survives
    when the client asked for streaming)
- Request body forwarded byte-for-byte from the inbound request.
- Response streamed back: status, response headers (except hop-by-hop), and
  body piped from `Response.body` to the Node `http.ServerResponse`.

**401-retry policy:**

On a `401` from Anthropic:

1. Re-read the Keychain entry. If the access token differs from the one used,
   retry once with the fresh token.
2. Otherwise, call `forceRefresh()` (acquires the file lock as above) and retry
   once.
3. If still `401`, return `401` to the client with an Anthropic-style error
   envelope and `error.type: "authentication_error"` plus
   `error.message: "claude max OAuth refresh failed — re-login via claude CLI"`.

## Data Flow — streaming request

1. Client SDK with `base_url=https://<worker-host>` posts
   `{"model": "claude-3-7-sonnet-…", "messages": [...], "stream": true}`.
2. Cloudflare Access challenges the user (browser SSO) or accepts a service
   token, then forwards the request to the Worker with
   `Cf-Access-Jwt-Assertion`.
3. The Worker verifies the JWT, then `fetch()`es the Tunnel hostname,
   forwarding the body stream.
4. cloudflared delivers the request to the agent on `127.0.0.1:8787`.
5. The agent ensures a fresh token, then fetches
   `api.anthropic.com/v1/messages` with the OAuth headers and streams the
   response body back.
6. The agent's response flows back up through the Tunnel, the Worker, and
   Access to the client — SSE frames intact.

## Error Handling

| Failure | Behavior |
| --- | --- |
| Anthropic 401 on inference | Re-read Keychain → retry once; else refresh → retry once; else `401` to client. |
| Refresh 4xx / `invalid_grant` | `401` with `{"error":{"type":"refresh_failed", "message":"re-login via claude"}}`. Log stack to stderr. |
| Anthropic 429 / 5xx | Forward status, body, and `retry-after` verbatim. No retry — clients handle backoff. |
| Tunnel unreachable from Worker | Worker returns `502 bad_gateway` with `{"error":{"type":"upstream_unavailable"}}`. |
| Access JWT invalid | Worker returns `403 forbidden`. Defense-in-depth — normally Access blocks first. |
| Malformed JSON body to agent | `400` with Anthropic-style error envelope, `error.type: "invalid_request_error"`. |
| Lock acquisition timeout | Refresh aborts with `503` and `retry-after: 1`; client retries. |

## Testing

- **Agent unit tests** (`agent/test/tokens.test.ts`):
  - `security` and `fetch` mocked.
  - Cases: token still valid (no refresh), token within threshold (refresh),
    refresh returns rotated `refresh_token` (written back), file lock held by
    another process (timeout path), Keychain mutated by Claude Code between
    threshold check and refresh (abandon path), 401-retry-with-fresh-read,
    401-retry-after-refresh, exhausted retries.
- **Worker unit tests** (`worker/test/index.test.ts`, Vitest + Miniflare):
  - Valid Access JWT → forwards to Tunnel, streaming preserved.
  - Invalid JWT → 403.
  - Wrong path / method → 404.
  - Tunnel `fetch` rejects → 502.
  - Hop-by-hop headers stripped.
- **Integration (agent against real Anthropic)**: opt-in via
  `PROXY_E2E_REAL=1` env. One non-streaming request, one streaming request.
  Asserts an `id`, `role: "assistant"`, and `message_stop` SSE event.
- **E2E**: `scripts/e2e.sh` runs `@anthropic-ai/sdk` against the Worker URL
  with a CF Access service token. Validates a streamed `message_stop` event.

## Project Layout

```
~/projects/claude-max-proxy/
├── .gitignore
├── .npmrc                          # save-exact=true
├── README.md
├── agent/
│   ├── package.json                # exact-pinned deps
│   ├── tsconfig.json
│   ├── src/
│   │   ├── server.ts
│   │   ├── tokens.ts
│   │   ├── upstream.ts
│   │   └── types.ts
│   └── test/
│       └── tokens.test.ts
├── worker/
│   ├── package.json
│   ├── tsconfig.json
│   ├── wrangler.jsonc
│   ├── src/
│   │   └── index.ts
│   └── test/
│       └── index.test.ts
├── cloudflared/
│   ├── config.yml.example
│   └── README.md                   # tunnel + DNS + Access policy walkthrough
├── scripts/
│   ├── install-launchd.sh          # registers the agent under launchd
│   └── e2e.sh
└── docs/superpowers/specs/
    └── 2026-06-17-claude-max-proxy-design.md   # this file
```

All Node sub-projects pin dependencies to exact versions and ship a local
`.npmrc` with `save-exact=true` per the user's `package.json` standards.

## Configuration & Secrets

- **Worker (wrangler secrets):** `TUNNEL_HOSTNAME`, `ACCESS_AUD`,
  `ACCESS_TEAM_DOMAIN`.
- **Worker (vars):** none.
- **cloudflared:** named tunnel UUID + credentials JSON in
  `~/.cloudflared/`. Hostname is created via
  `cloudflared tunnel route dns <tunnel> <hostname>` and gated by a Cloudflare
  Access service-token policy that allows only the Worker's principal.
- **Agent:** no secrets in env or files; the Keychain is the source of truth.
  The agent must run as the macOS login user that owns the Keychain entry
  (`security` will prompt or fail otherwise — `launchd` runs under the user
  domain to satisfy this).

## Risks & Mitigations

1. **Anthropic detects Worker-IP inference traffic and throttles.** Inference
   traffic still egresses from Cloudflare to `api.anthropic.com`, but only the
   short Worker → Tunnel hop is on Cloudflare; the actual upstream call is from
   the Mac. *Mitigation:* none needed in this architecture — both refresh and
   inference happen on residential IP.
2. **Refresh token rotation race with interactive Claude Code.** Both can refresh,
   either could overwrite the other. *Mitigation:* file lock + re-read inside
   the lock + write-back; on 401, retry once with a freshly-read token before
   refreshing.
3. **Keychain access prompts.** macOS Keychain may prompt for password when an
   unknown process reads `Claude Code-credentials`. *Mitigation:* run the agent
   under launchd in the user domain so the existing ACL on the Keychain item
   admits the `security` binary; document `security set-generic-password-partition-list`
   if prompts persist.
4. **Anthropic rotates the hardcoded OAuth client_id or beta header.** Rare but
   possible. *Mitigation:* both values live in `agent/src/tokens.ts` constants
   with a comment pointing at this spec for context.
5. **Subscription-account usage classification.** Heavy automated load may push
   the account toward rate-limits intended for interactive use. *Mitigation:*
   none — out of scope; user accepts the risk.
6. **Anthropic Max-plan ToS.** Using a consumer subscription as a programmatic
   API backend behind a personal proxy is a gray area. *Mitigation:* keep the
   surface single-user behind Access and document the risk.

## Open Questions

None at design time. Implementation may surface details (exact launchd
plist path, JWKS cache strategy, lockfile naming on multi-user machines) that
will be decided in the plan.
