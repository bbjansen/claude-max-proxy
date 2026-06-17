# claude-max-proxy

Expose a **Claude Max consumer subscription** as a standard Anthropic
`POST /v1/messages` endpoint, fronted by a Cloudflare Worker. Use any
Anthropic-SDK-compatible client (Claude SDK, OpenRouter, your own scripts)
against your Max plan instead of paying for separate API credits.

> ⚠️ Using a consumer Max subscription as a programmatic API backend sits in
> a gray area of Anthropic's ToS. Single-user, behind your own auth, is the
> intended scope — sharing it more broadly raises real risk of throttling or
> suspension.

## Architecture

```
┌─────────────────────────┐
│ Anthropic SDK client    │  Authorization: Bearer <PROXY_KEY>
└────────────┬────────────┘  (or Cf-Access-Jwt-Assertion)
             │
             ▼
┌─────────────────────────┐
│ Cloudflare Worker       │  verifies bearer/JWT, strips hop-by-hop headers
│ (claude-max-proxy)      │  injects optional CF Access service token
└────────────┬────────────┘
             │ HTTPS via Cloudflare Tunnel
             ▼
┌─────────────────────────┐
│ cloudflared             │  on your Mac, registered with Cloudflare
└────────────┬────────────┘
             │ http://localhost:8787
             ▼
┌─────────────────────────┐
│ Local agent (Node)      │  reads OAuth tokens from macOS Keychain,
│                         │  refreshes on demand from residential IP,
│                         │  forwards to api.anthropic.com
└────────────┬────────────┘
             │ Authorization: Bearer <oauth>
             ▼
       api.anthropic.com/v1/messages
```

Egress to Anthropic happens from the residential IP — not from Cloudflare's
datacenters — to avoid Anthropic's WAF blocking OAuth refresh from datacenter
ranges.

## Setup

### 0. Prerequisites

- macOS with the Claude Code CLI installed and logged in (the agent reads
  the OAuth tokens from `Claude Code-credentials` in Keychain).
- A Cloudflare account with a zone (domain) attached.
- Node 20+.
- `brew install cloudflared`.
- `npm install` at the repo root.

### 1. Cloudflare API token

Create a token at <https://dash.cloudflare.com/profile/api-tokens> with:

- Account → Workers Scripts → Edit
- Account → Cloudflare Tunnel → Edit
- Account → Account Settings → Read
- Zone → DNS → Edit (on your zone)

Save it as `~/.claude-max-proxy.cf` with mode 0600.

### 2. Tunnel + DNS

Replace `<ZONE>` with your zone (e.g. `example.com`).

```bash
TOKEN=$(cat ~/.claude-max-proxy.cf)
AID=<your-account-id>
ZID=<your-zone-id>

# Create tunnel
SECRET=$(openssl rand -base64 32)
RESP=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$AID/cfd_tunnel" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"name\":\"claude-max-proxy\",\"tunnel_secret\":\"$SECRET\",\"config_src\":\"local\"}")
UUID=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["id"])')

# Save credentials
mkdir -p ~/.cloudflared
python3 -c "import json,os;json.dump({'AccountTag':'$AID','TunnelID':'$UUID','TunnelName':'claude-max-proxy','TunnelSecret':'$SECRET'},open(os.path.expanduser('~/.cloudflared/'+'$UUID'+'.json'),'w'))"

# DNS — single-level subdomain to stay inside Universal SSL coverage
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"type\":\"CNAME\",\"name\":\"claude-agent\",\"content\":\"$UUID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
```

Write `~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/<user>/.cloudflared/<UUID>.json
ingress:
  - hostname: claude-agent.<ZONE>
    service: http://localhost:8787
  - service: http_status:404
```

### 3. Worker config

Edit `worker/wrangler.jsonc`:

```jsonc
"vars": {
  "TUNNEL_HOSTNAME": "claude-agent.<ZONE>",
  "ACCESS_TEAM_DOMAIN": "REPLACE_WITH_TEAM.cloudflareaccess.com"
}
```

### 4. Deploy

Generate a proxy key, push as a Worker secret, deploy:

```bash
PROXY_KEY=$(openssl rand -hex 32)
echo -n "$PROXY_KEY" > ~/.claude-max-proxy.key && chmod 600 ~/.claude-max-proxy.key

cd worker
CLOUDFLARE_API_TOKEN=$(cat ~/.claude-max-proxy.cf) \
CLOUDFLARE_ACCOUNT_ID=<your-account-id> \
  bash -c "echo -n '$PROXY_KEY' | npx wrangler secret put PROXY_KEY"

CLOUDFLARE_API_TOKEN=$(cat ~/.claude-max-proxy.cf) \
CLOUDFLARE_ACCOUNT_ID=<your-account-id> \
  npx wrangler deploy
```

### 5. Persistent services on the Mac

```bash
# Agent under user launchd
./scripts/install-launchd.sh

# Cloudflared under user launchd
cp scripts/com.bobjansen.cloudflared-claude.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.bobjansen.cloudflared-claude.plist
```

(Rename the plist labels and file paths to suit your machine — they're
templated for one specific install.)

### 6. Verify

```bash
WORKER_URL=https://claude-max-proxy.<your-subdomain>.workers.dev \
  ./scripts/e2e.sh
```

Expected: `PASS` after the gate (403 unauthenticated), non-streaming, and
streaming legs.

## Use it

```bash
PROXY_KEY=$(cat ~/.claude-max-proxy.key)
curl -X POST https://claude-max-proxy.<your-subdomain>.workers.dev/v1/messages \
  -H "authorization: Bearer $PROXY_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'
```

For SDK clients, set the Anthropic base URL to your Worker URL and pass the
proxy key in `Authorization: Bearer …`.

## Auth modes

The Worker accepts either of:

1. **Bearer:** `Authorization: Bearer <PROXY_KEY>` — set via
   `wrangler secret put PROXY_KEY`. Simplest.
2. **Cloudflare Access JWT:** `Cf-Access-Jwt-Assertion: <JWT>` — auto-set by
   Cloudflare Access when an Access app sits in front of the Worker URL.

To migrate from bearer to Access:

1. Enable Cloudflare Zero Trust at <https://one.dash.cloudflare.com/> and
   pick a team subdomain (used as `<team>.cloudflareaccess.com`).
2. Create an Access self-hosted application for your Worker URL with an
   email/SSO policy.
3. `wrangler secret put ACCESS_AUD` (from the application's AUD tag) and
   update `ACCESS_TEAM_DOMAIN` in `worker/wrangler.jsonc`.
4. Redeploy.
5. Optional: create a separate Access app for the tunnel hostname with a
   service-token policy; put the client ID/secret in
   `TUNNEL_ACCESS_CLIENT_ID` and `TUNNEL_ACCESS_CLIENT_SECRET` Worker secrets
   so direct hits to the tunnel hostname fail too.
6. Once both are in place, `wrangler secret delete PROXY_KEY` to drop bearer.

## How the OAuth handling works

- Tokens live in macOS Keychain under service `Claude Code-credentials`,
  written by the Claude Code CLI on first login.
- The agent reads the credential, caches it in memory.
- If `expiresAt - now < 60s`, the agent refreshes against
  `https://platform.claude.com/v1/oauth/token` with the hardcoded client_id
  Claude Code uses (`9d1c250a-…`).
- Refresh tokens **rotate on every use**, so the agent persists the new
  refresh token back to Keychain atomically. A file lock at
  `~/.claude/.proxy-refresh.lock` keeps interactive Claude Code and the
  proxy from invalidating each other's tokens.
- Required headers on the upstream call:
  - `Authorization: Bearer <access_token>` (NOT `x-api-key`)
  - `anthropic-beta: oauth-2025-04-20,claude-code-20250219`
  - `anthropic-version: 2023-06-01`
  - `x-app: cli`

If the refresh chain ever breaks, run `claude` once interactively to
re-seed the Keychain entry.

## Why the Worker AND the Tunnel?

A Cloudflare Worker cannot call `api.anthropic.com` directly — Anthropic's
WAF blocks OAuth refresh from datacenter IPs ([claude-code#47754][waf]).
Splitting the path so all Anthropic-bound egress happens from the Mac (a
residential IP) avoids this.

[waf]: https://github.com/anthropics/claude-code/issues/47754

## Sub-packages

- `agent/` — Node agent that runs on the Mac.
- `worker/` — Cloudflare Worker.
- `cloudflared/` — Tunnel config notes.
- `scripts/` — install + e2e helpers.
- `docs/` — design spec and implementation plan.

## Tests

```bash
cd agent  && npm test    # unit
cd worker && npm test    # unit
scripts/smoke-agent.sh                                # local agent (real Anthropic)
WORKER_URL=... scripts/e2e.sh                         # deployed worker
```

## Operations

- **Logs:** `~/Library/Logs/claude-max-proxy.{out,err}.log`,
  `~/Library/Logs/cloudflared-claude.{out,err}.log`.
- **Rebuild + restart agent:**
  `cd agent && npm run build && launchctl kickstart -k gui/$(id -u)/<your-launchd-label>`.
- **Redeploy worker:**
  `cd worker && CLOUDFLARE_API_TOKEN=$(cat ~/.claude-max-proxy.cf) npx wrangler deploy`.

## License

Unlicensed by default — fork and adapt for personal use. No warranty;
use at your own risk including any Anthropic ToS considerations.
