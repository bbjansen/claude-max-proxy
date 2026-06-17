#!/usr/bin/env bash
set -euo pipefail

URL="${URL:-http://127.0.0.1:8787/v1/messages}"

echo "--- non-streaming ---"
curl -sS -X POST "$URL" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 32,
    "messages": [{"role": "user", "content": "Respond with the single word: PONG"}]
  }' | tee /tmp/smoke-nonstream.json
echo
grep -q '"type":"message"' /tmp/smoke-nonstream.json
grep -q 'PONG' /tmp/smoke-nonstream.json || echo "WARN: model did not answer PONG (still a success if status was 200)"

echo
echo "--- streaming ---"
curl -sS -N -X POST "$URL" \
  -H "content-type: application/json" \
  -H "accept: text/event-stream" \
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 32,
    "stream": true,
    "messages": [{"role": "user", "content": "Stream the single word: PONG"}]
  }' | tee /tmp/smoke-stream.txt
echo
grep -q 'event: message_start' /tmp/smoke-stream.txt
grep -q 'event: message_stop' /tmp/smoke-stream.txt

echo
echo "OK"
