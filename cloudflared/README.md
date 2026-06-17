# Cloudflare Tunnel setup

The local agent listens on `127.0.0.1:8787`. Cloudflare Tunnel exposes it to
the Worker over a private Cloudflare-hosted hostname, gated by Access.

## One-time setup

1. `brew install cloudflared`
2. `cloudflared tunnel login` — picks the Cloudflare zone (your domain).
3. `cloudflared tunnel create claude-max-proxy`
4. `cloudflared tunnel route dns claude-max-proxy <hostname>` (e.g.
   `claude-agent.internal.example.com`).
5. Copy `config.yml.example` to `~/.cloudflared/config.yml` and fill in your
   tunnel UUID and chosen hostname.
6. In the Cloudflare Zero Trust dashboard, create an Access application for
   the hostname with a **Service Auth** policy and a service token. Record
   the AUD tag, team domain, client ID and secret — the Worker needs them.

## Run

Foreground (for testing): `cloudflared tunnel run claude-max-proxy`

Background (recommended): `sudo cloudflared service install` — installs a
launchd plist that runs the tunnel under root using `~/.cloudflared/config.yml`.
