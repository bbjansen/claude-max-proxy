#!/usr/bin/env bash
set -euo pipefail

# capture-max-account.sh — promote the default Keychain entry that `claude` just
# wrote into a stable, account-specific entry so the next `claude login` won't
# overwrite it.
#
# Usage: capture-max-account.sh <max-account-email>

SVC="Claude Code-credentials"
DEFAULT_ACCT="$(id -un)"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <max-account-email>" >&2
  exit 64
fi

NEW_ACCT="$1"

PAYLOAD="$(security find-generic-password -s "$SVC" -a "$DEFAULT_ACCT" -w 2>/dev/null || true)"
if [[ -z "$PAYLOAD" ]]; then
  echo "error: no Keychain entry found under svce='$SVC', acct='$DEFAULT_ACCT'." >&2
  echo "       Did you run 'claude' to log in first?" >&2
  exit 65
fi

if ! grep -q '"claudeAiOauth"' <<<"$PAYLOAD"; then
  echo "error: default entry doesn't look like a Claude OAuth credential." >&2
  exit 66
fi

security add-generic-password -U -s "$SVC" -a "$NEW_ACCT" -w "$PAYLOAD"
security delete-generic-password -s "$SVC" -a "$DEFAULT_ACCT" >/dev/null

echo "captured Keychain entry under acct='$NEW_ACCT'."
echo "next: run 'claude logout && claude' to log in as the next Max account, then run this script again."
