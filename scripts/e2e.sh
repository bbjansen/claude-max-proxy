#!/usr/bin/env bash
set -euo pipefail

: "${WORKER_URL:?set WORKER_URL, e.g. https://claudette.<your-workers-subdomain>.workers.dev}"

# Auth mode: PROXY_KEY for the bearer path, or cloudflared access curl for CF Access SSO.
PROXY_KEY="${PROXY_KEY:-$(cat ~/.claude-max-proxy.key 2>/dev/null || true)}"

if [[ -n "$PROXY_KEY" ]]; then
  AUTH_HEADER=(-H "authorization: Bearer $PROXY_KEY")
  CURL=(curl -sS)
else
  AUTH_HEADER=()
  CURL=(cloudflared access curl)
fi

echo "=== 1) gate: no auth must NOT be 200 ==="
CODE=$(curl -o /dev/null -s -w "%{http_code}" -X POST "$WORKER_URL/v1/messages" -H "content-type: application/json" -d '{}')
echo "  unauthenticated status: $CODE"
[[ "$CODE" == "200" ]] && { echo "FAIL: endpoint is not gated"; exit 1; }

echo
echo "=== 2) non-streaming ==="
"${CURL[@]}" -X POST "$WORKER_URL/v1/messages" "${AUTH_HEADER[@]}" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"Respond: PONG"}]}' \
  | tee /tmp/e2e1.json
echo
grep -q '"type":"message"' /tmp/e2e1.json || { echo "FAIL: no message in response"; exit 1; }

echo
echo "=== 3) streaming ==="
"${CURL[@]}" -N -X POST "$WORKER_URL/v1/messages" "${AUTH_HEADER[@]}" \
  -H "content-type: application/json" -H "accept: text/event-stream" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Stream: PONG"}]}' \
  | tee /tmp/e2e2.txt
echo
grep -q 'event: message_start' /tmp/e2e2.txt || { echo "FAIL: no message_start"; exit 1; }
grep -q 'event: message_stop'  /tmp/e2e2.txt || { echo "FAIL: no message_stop"; exit 1; }

echo
echo "PASS"
