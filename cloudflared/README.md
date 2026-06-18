# Cloudflare Tunnel setup

The local agent listens on `127.0.0.1:8787`. Cloudflare Tunnel exposes it
to the Worker over a private Cloudflare-hosted hostname, gated by Access
(or simply unguessable + secret-token-protected for personal use).

## One-time setup

1. `brew install cloudflared`
2. `cloudflared tunnel login` — pick the Cloudflare zone you own.
3. `cloudflared tunnel create claudette`
4. `cloudflared tunnel route dns claudette claudette-agent.<your-zone>`
5. Copy `config.yml.example` to `~/.cloudflared/config.yml` and fill in
   your tunnel UUID and chosen hostname.
6. In the Cloudflare Zero Trust dashboard, optionally create an Access
   application for the hostname with a **Service Auth** policy and a
   service token. Record the AUD tag, team domain, client ID and secret —
   the Worker needs them.

## Run

Foreground (for testing): `cloudflared tunnel run claudette`

Background (recommended): install the user-mode plist from
`../scripts/dev.claudette.cloudflared.plist` via `launchctl bootstrap`,
or run `sudo cloudflared service install` to register it under the system
launchd domain.
