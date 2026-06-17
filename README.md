# claude-max-proxy

Self-hosted proxy that exposes a Claude Max consumer subscription as a standard
Anthropic `POST /v1/messages` endpoint.

Architecture: Cloudflare Worker (auth front door) → Cloudflare Tunnel →
local Node agent on macOS (holds OAuth tokens) → `api.anthropic.com`.

See `docs/superpowers/specs/2026-06-17-claude-max-proxy-design.md` for the full
design and `docs/superpowers/plans/2026-06-17-claude-max-proxy.md` for the
implementation plan.

## Deployed resources (this account)

- **Public endpoint:** `https://claude-max-proxy.bobjansen.workers.dev/v1/messages`
- **Tunnel hostname:** `claude-agent.bobjansen.dev` (CNAME → tunnel `2931827e-…`)
- **Worker secret `PROXY_KEY`:** stored in `~/.claude-max-proxy.key` (mode 0600)
- **Cloudflare API token:** stored in `~/.claude-max-proxy.cf` (mode 0600)
- **launchd services (user domain):**
  - `com.bobjansen.claude-max-proxy` — Node agent on `127.0.0.1:8787`
  - `com.bobjansen.cloudflared-claude` — `cloudflared tunnel run claude-max-proxy`

## Usage

```bash
PROXY_KEY=$(cat ~/.claude-max-proxy.key)
curl -X POST https://claude-max-proxy.bobjansen.workers.dev/v1/messages \
  -H "authorization: Bearer $PROXY_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'
```

Anthropic SDK clients: set `base_url` to
`https://claude-max-proxy.bobjansen.workers.dev` and pass the bearer token in
the `Authorization` header.

## Auth modes

The Worker accepts either:

1. **Bearer:** `Authorization: Bearer <PROXY_KEY>` — current mode. Set via
   `wrangler secret put PROXY_KEY`.
2. **Cloudflare Access JWT:** `Cf-Access-Jwt-Assertion: <JWT>` — auto-set by
   Cloudflare Access when an Access app sits in front of the Worker URL.

To migrate from (1) to (2):

1. Enable Cloudflare Zero Trust at `https://one.dash.cloudflare.com/` and pick
   a team subdomain (e.g. `bobjansen`).
2. Create an Access self-hosted application for
   `claude-max-proxy.bobjansen.workers.dev` with an email/SSO policy.
3. `wrangler secret put ACCESS_AUD` (from the application's AUD tag) and
   update `ACCESS_TEAM_DOMAIN` in `worker/wrangler.jsonc`.
4. Redeploy.
5. (Optional) Create a separate Access app for `claude-agent.bobjansen.dev`
   with a service-token policy; put the client ID/secret in
   `TUNNEL_ACCESS_CLIENT_ID` and `TUNNEL_ACCESS_CLIENT_SECRET` Worker secrets
   so direct hits to the tunnel hostname fail.
6. Once both are in place, `wrangler secret delete PROXY_KEY` to drop bearer
   support.

## Sub-packages

- `agent/` — Node agent that runs on the Mac.
- `worker/` — Cloudflare Worker.
- `cloudflared/` — Tunnel config and setup notes.
- `scripts/` — install + e2e helpers.

## Tests

```bash
# Unit
cd agent  && npm test
cd worker && npm test

# Local smoke (against real Anthropic via the local agent on 8787)
scripts/smoke-agent.sh

# Full e2e through the deployed Worker
WORKER_URL=https://claude-max-proxy.bobjansen.workers.dev scripts/e2e.sh
```

## Operations

- **View logs:** `tail -f ~/Library/Logs/claude-max-proxy.{out,err}.log`
  and `~/Library/Logs/cloudflared-claude.{out,err}.log`.
- **Rebuild + restart agent:**
  `cd agent && npm run build && launchctl kickstart -k gui/$(id -u)/com.bobjansen.claude-max-proxy`.
- **Redeploy worker:**
  `cd worker && CLOUDFLARE_API_TOKEN=$(cat ~/.claude-max-proxy.cf) npx wrangler deploy`.

## Token rotation

Refresh tokens rotate on every use. The agent re-reads the Keychain under a
file lock before refreshing, so interactive Claude Code and the agent can both
refresh without invalidating each other. If both ever go out of sync, run
`claude` once interactively to re-login — that re-seeds the Keychain entry.
