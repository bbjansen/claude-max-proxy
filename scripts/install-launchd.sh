#!/usr/bin/env bash
set -euo pipefail

# install-launchd.sh — register the claudette agent as a launchd user agent.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.claudette.agent"
PLIST_SRC="$ROOT/scripts/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Building agent..."
(cd "$ROOT/agent" && npm run build)

NODE_PATH="$(command -v node)"
if [[ -z "$NODE_PATH" ]]; then echo "node not found on PATH"; exit 1; fi
echo "Using node at $NODE_PATH"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Substitute USERNAME, the project root, and the node binary path.
TMP_PLIST="$(mktemp)"
sed \
  -e "s|/Users/USERNAME|$HOME|g" \
  -e "s|/usr/local/bin/node|$NODE_PATH|g" \
  -e "s|projects/claudette|${ROOT#$HOME/}|g" \
  "$PLIST_SRC" > "$TMP_PLIST"
cp "$TMP_PLIST" "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"
sleep 1
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,20p' || true

echo
echo "Tailing $HOME/Library/Logs/claudette.out.log (Ctrl-C to stop):"
tail -n 20 "$HOME/Library/Logs/claudette.out.log" 2>/dev/null || true
