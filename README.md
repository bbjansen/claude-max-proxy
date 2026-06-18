# claudette

A self-hosted proxy that exposes your **Claude Max** subscription as a
standard Anthropic `POST /v1/messages` endpoint, then load-balances
requests across **N Max accounts** for combined quota. Built for
personal use: one operator, many subscriptions, one public URL.

> **ToS note.** Anthropic's Max plan ToS is grey on programmatic use.
> claudette is for **personal, single-user** deployment behind your own
> auth gate. Heavier sharing (multi-user, multi-tenant) raises the risk
> of throttling or account action. You assume that risk.

## What you get

- One HTTPS URL serving the Anthropic Messages API (`/v1/messages`,
  streaming SSE supported) plus an OpenAI compatibility shim
  (`/v1/chat/completions`, `/v1/models`) for tools that only speak
  OpenAI.
- Round-robin load balancing across every Max account you've captured,
  with per-(account, model-tier) cooldown on `429 rate_limit_error`.
- An admin endpoint to inspect pool health and disable/enable accounts
  on the fly.
- PKCE OAuth flow per account (`agent login --acct you@example.com`) —
  no credentials shared with the Claude Code CLI.

## Architecture

```
[ Anthropic SDK / OpenAI SDK / curl ]
        │  Authorization: Bearer <PROXY_KEY>
        ▼
[ Cloudflare Worker ]                    deployed at https://<your-worker>.workers.dev
        │  cf-access-* service token
        ▼
[ Cloudflare Tunnel ]                    cloudflared on your Mac
        │  http://127.0.0.1:8787
        ▼
[ claudette agent ]                      Node, launchd, reads OAuth tokens from your Mac's Keychain
        │  Authorization: Bearer <oauth>  + anthropic-beta headers
        ▼
[ api.anthropic.com/v1/messages ]
```

The agent egresses from your Mac's residential IP — this matters,
because Anthropic's WAF blocks OAuth refresh from datacenter IPs.

## Prerequisites

- macOS with the Claude Code CLI installed at least once (used for the
  first-run credential migration; not required if you start fresh).
- A Cloudflare account with a zone (i.e., you own a domain managed by
  Cloudflare).
- Node 20+.
- `brew install cloudflared`.

## Setup (≈15 minutes)

### 1. Clone

```sh
git clone https://github.com/bbjansen/claudette.git
cd claudette
npm install
```

### 2. Create the Cloudflare Tunnel

```sh
cloudflared tunnel login                                # pick your zone
cloudflared tunnel create claudette
cloudflared tunnel route dns claudette claudette-agent.<your-zone>
cp cloudflared/config.yml.example ~/.cloudflared/config.yml
# Edit ~/.cloudflared/config.yml: fill in the UUID and hostname.
```

### 3. Deploy the Worker

```sh
cd worker
# Edit wrangler.jsonc:
#   TUNNEL_HOSTNAME → "claudette-agent.<your-zone>"
#   ACCESS_TEAM_DOMAIN → "<your-team>.cloudflareaccess.com"  (or leave default if not using Access)
npx wrangler login
PROXY_KEY="$(openssl rand -hex 32)"
echo -n "$PROXY_KEY" | npx wrangler secret put PROXY_KEY
npx wrangler deploy
```

Save `$PROXY_KEY` — it's how you authenticate to the proxy from clients.

### 4. PKCE login for each Max account

```sh
cd ../agent && npm run build
node dist/index.js login --acct you@example.com
# Browser opens; sign in as the corresponding Max account; close tab.
# Repeat for each additional account.
```

### 5. Persistent services on the Mac

```sh
./scripts/install-launchd.sh           # registers the agent under launchd
cp scripts/dev.claudette.cloudflared.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.claudette.cloudflared.plist
```

### 6. Verify

```sh
curl -sS http://127.0.0.1:8787/v1/admin/accounts | jq
# → JSON snapshot of the pool with your captured accounts.

WORKER_URL=https://claudette.<your-workers-subdomain>.workers.dev \
PROXY_KEY=$PROXY_KEY \
  ./scripts/e2e.sh
# → "PASS" after gate / non-streaming / streaming legs.
```

## Use it

```sh
PROXY_KEY=$(cat secrets/proxy-key)  # or wherever you saved it
curl -X POST https://claudette.<your-workers-subdomain>.workers.dev/v1/messages \
  -H "authorization: Bearer $PROXY_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'
```

Anthropic SDK clients:

```py
from anthropic import Anthropic
client = Anthropic(api_key=PROXY_KEY, base_url="https://claudette.<your-workers-subdomain>.workers.dev")
msg = client.messages.create(model="claude-haiku-4-5", max_tokens=64,
                             messages=[{"role":"user","content":"hi"}])
```

OpenAI SDK clients pointed at the shim:

```py
from openai import OpenAI
client = OpenAI(api_key=PROXY_KEY,
                base_url="https://claudette.<your-workers-subdomain>.workers.dev/v1")
resp = client.chat.completions.create(model="claude-haiku-4-5",
                                      messages=[{"role":"user","content":"hi"}])
```

## Endpoints

| Method | Path | Format | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/messages` | Anthropic | Pass-through, streaming SSE preserved |
| `POST` | `/v1/chat/completions` | OpenAI | Translated to/from Anthropic |
| `GET`  | `/v1/models` | OpenAI list | Static list of Claude models |
| `POST` | `/v1/embeddings` | OpenAI | Returns 501 — Anthropic has no embeddings API |
| `GET`  | `/v1/admin/accounts` | Custom | Pool snapshot (cooldown, last-used, disabled) |
| `POST` | `/v1/admin/accounts/{id}/disable` | Custom | Skip account in selector |
| `POST` | `/v1/admin/accounts/{id}/enable` | Custom | Re-include after disable |

All endpoints require `Authorization: Bearer <PROXY_KEY>` or, if Cloudflare
Access is configured in front, a valid Access JWT.

## Adding more accounts later

```sh
node ~/projects/claudette/agent/dist/index.js login --acct second@example.com
```

The agent's `KeychainWatcher` adds the new account to the pool within 5s
without a restart.

## Auth modes

claudette supports two inbound auth modes; you can mix them:

1. **Bearer (recommended for personal use).** `Authorization: Bearer <PROXY_KEY>`
   — a single shared secret set via `wrangler secret put PROXY_KEY`. Or
   `x-api-key: <PROXY_KEY>` for Anthropic-native SDK clients.
2. **Cloudflare Access.** Put an Access application in front of the
   Worker URL and pass the issued JWT. Configure
   `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` Worker secrets and the agent
   validates the JWT signature and audience.

Mix freely — the Worker accepts either.

## Why Cloudflare Worker + Tunnel?

Anthropic's WAF blocks OAuth refresh from datacenter IPs. A pure Worker
deployment would 403 on every refresh. The Tunnel keeps all
Anthropic-bound egress on your Mac's residential IP, while the Worker
provides a stable public URL with edge auth.

## FAQ

**Does this break interactive Claude Code on the same Mac?**
No. claudette stores its tokens under a separate Keychain service
(`claude-max-proxy-credentials`); the Claude Code CLI keeps using
`Claude Code-credentials` and refreshes independently.

**What if Anthropic rate-limits a model on one account?**
The agent marks `(account, model-tier)` as cooled-down for the duration
of the `Retry-After` header (or 5 minutes if absent) and routes future
requests for that tier to a different account. Retries up to 3 attempts
per request.

**Can I run multiple proxies?**
Yes, but each Mac running an agent should hold a disjoint set of
accounts (each account's OAuth refresh chain is single-writer). For
multi-machine setups, partition by `CLAUDE_MAX_ACCOUNTS` env var.

**What's the security model?**
Single-user. The proxy holds long-lived OAuth tokens. Anyone with
`PROXY_KEY` (or a valid Access JWT) can use your Max plan via the proxy.
Treat it like an API key: store it in a password manager, rotate when
sharing changes.

**ToS again?**
You're using your Max subscription via the official Messages API with
the OAuth credentials Claude Code uses. The pattern works; whether it's
within ToS at any given moment depends on Anthropic. Heavy sharing or
multi-tenant operation is more likely to draw attention than personal
use behind Access.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Inspired by the open Claude OAuth ecosystem and the OAuth bearer pattern
documented in [anthropics/claude-code](https://github.com/anthropics/claude-code).
The proxy-from-residential-IP architecture comes from
[claude-code#47754](https://github.com/anthropics/claude-code/issues/47754).
