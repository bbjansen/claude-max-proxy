#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bobjansen.claude-max-proxy"
PLIST_SRC="$ROOT/scripts/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Building agent..."
(cd "$ROOT/agent" && npm run build)

NODE_PATH="$(command -v node)"
if [[ -z "$NODE_PATH" ]]; then echo "node not found on PATH"; exit 1; fi
echo "Using node at $NODE_PATH"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

TMP_PLIST="$(mktemp)"
sed "s|/usr/local/bin/node|${NODE_PATH//|/\\|}|" "$PLIST_SRC" > "$TMP_PLIST"
cp "$TMP_PLIST" "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"
sleep 1
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,20p' || true

echo
echo "Tailing $HOME/Library/Logs/claude-max-proxy.out.log (Ctrl-C to stop):"
tail -n 20 "$HOME/Library/Logs/claude-max-proxy.out.log" 2>/dev/null || true
