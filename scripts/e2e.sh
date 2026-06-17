#!/usr/bin/env bash
set -euo pipefail

: "${WORKER_URL:?set WORKER_URL to the deployed worker URL, e.g. https://claude-max-proxy.<sub>.workers.dev}"

echo "=== 1) JWT gate: unauthenticated request must NOT return 200 ==="
status=$(curl -o /dev/null -s -w "%{http_code}" -X POST "$WORKER_URL/v1/messages" -H "content-type: application/json" -d '{}')
echo "  unauthenticated status: $status"
if [[ "$status" == "200" ]]; then echo "FAIL: endpoint is not gated"; exit 1; fi

echo
echo "=== 2) Non-streaming request via cloudflared access curl ==="
out=$(cloudflared access curl "$WORKER_URL/v1/messages" \
  -X POST -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"Respond: PONG"}]}')
echo "$out" | head -c 400; echo
echo "$out" | grep -q '"type":"message"' || { echo "FAIL: no message in response"; exit 1; }

echo
echo "=== 3) Streaming request via cloudflared access curl ==="
out=$(cloudflared access curl "$WORKER_URL/v1/messages" \
  -X POST -H "content-type: application/json" -H "accept: text/event-stream" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Stream: PONG"}]}')
echo "$out" | head -n 30
echo "$out" | grep -q 'event: message_start' || { echo "FAIL: no message_start"; exit 1; }
echo "$out" | grep -q 'event: message_stop'  || { echo "FAIL: no message_stop"; exit 1; }

echo
echo "PASS"
