# Capturing multiple Max-account OAuth credentials

claudette runs its own OAuth (PKCE) flow per Max account and stores the
resulting tokens under the macOS Keychain service
`claude-max-proxy-credentials`. The service name is a historical name
preserved for backwards compatibility — claudette is the project, the
Keychain service name predates the rename. The agent never reads from
`Claude Code-credentials` after the first-run migration, so interactive
Claude Code can run on the same Mac with no shared credential state.

## Capturing a new account

For each Max email you want in the pool:

```sh
node ~/projects/claudette/agent/dist/index.js login --acct you@example.com
```

(or during development: `npm --prefix ~/projects/claudette/agent run dev -- login --acct you@example.com`)

The command opens your default browser to the Anthropic OAuth page. Sign
in as the Max account whose email you passed in `--acct`. The browser is
redirected to a one-shot local server on `127.0.0.1:<random>` which
captures the code, exchanges it for tokens, writes them to Keychain, and
exits.

Within 5 seconds, the running agent's `KeychainWatcher` adds the new
account to the rotation pool. Verify via the admin endpoint:

```sh
curl -sS http://127.0.0.1:8787/v1/admin/accounts | jq '.accounts[].acct_id'
```

## First-run migration (existing claude-max-proxy users)

If you were running an earlier build that read from `Claude Code-credentials`
(the credential the Claude Code CLI itself manages), claudette migrates
those entries into its own Keychain service on first start, with no
re-login. You'll see:

```
[agent] migrated N credentials from "Claude Code-credentials" to "claude-max-proxy-credentials"
```

The migration is idempotent. You can re-run it manually with:

```sh
node ~/projects/claudette/agent/dist/index.js migrate
```

After migration, the two services drift independently: claudette
refreshes its own tokens; the Claude Code CLI refreshes the originals.

## Disabling an account temporarily

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/you@example.com/disable
```

Re-enable:

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/you@example.com/enable
```

The manually-disabled flag is in-memory; an agent restart clears it.

## Allowlisting accounts

Set `CLAUDE_MAX_ACCOUNTS=<email1>,<email2>` in the launchd plist's
`EnvironmentVariables` to restrict the pool to a subset without removing
the Keychain entries.

## Removing an account permanently

```sh
security delete-generic-password -s "claude-max-proxy-credentials" -a "you@example.com"
```

The watcher's next tick drops it from the pool.

## SSH / headless caveat

`agent login` opens a browser via `open` on macOS. If you're on an SSH
session into the Mac, `open` runs on the remote display (no browser
opens locally). Either run `agent login` from a graphical session, or
SSH-tunnel the random port the callback server picks and complete the
flow from a browser on your workstation.
