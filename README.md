# claude-max-proxy

Self-hosted proxy that exposes a Claude Max consumer subscription as a standard
Anthropic `POST /v1/messages` endpoint.

Architecture: Cloudflare Worker (Zero Trust front door) → Cloudflare Tunnel →
local Node agent on macOS (holds OAuth tokens) → `api.anthropic.com`.

See `docs/superpowers/specs/2026-06-17-claude-max-proxy-design.md` for the full
design and `docs/superpowers/plans/2026-06-17-claude-max-proxy.md` for the
implementation plan.

## Sub-packages

- `agent/` — Node agent that runs on the Mac.
- `worker/` — Cloudflare Worker.
- `cloudflared/` — Tunnel config and setup notes.
- `scripts/` — install + e2e helpers.
