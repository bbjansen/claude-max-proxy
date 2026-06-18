# Capturing multiple Max-account OAuth credentials

The proxy agent runs its own OAuth (PKCE) flow per Max account and stores
the resulting tokens under the macOS Keychain service
`claude-max-proxy-credentials`. The agent never reads from or writes to
`Claude Code-credentials` after the first-run migration — interactive
Claude Code can run on the same Mac with no shared credential state.

## Capturing a new account

For each Max email you want in the pool:

```sh
node ~/projects/claude-max-proxy/agent/dist/index.js login --acct <email>
```

(or, while developing: `npm --prefix ~/projects/claude-max-proxy/agent run dev -- login --acct <email>`)

The command opens your default browser to the Anthropic OAuth page.
Sign in as the Max account whose email you passed in `--acct`. The
browser is redirected to a one-shot local server on `127.0.0.1:<random>`
which captures the code, exchanges it for tokens, writes them to
Keychain, and exits.

Within 5 seconds, the running agent's `KeychainWatcher` adds the new
account to the rotation pool. Verify via the admin endpoint:

```sh
curl -sS http://127.0.0.1:8787/v1/admin/accounts | jq '.accounts[].acct_id'
```

## First-run migration (existing users)

If you were running an earlier build that read from
`Claude Code-credentials`, you do **not** need to log in again. On its
first start after the upgrade, the agent calls `runMigrationOnce` which
copies every old entry into the new service:

```
[agent] migrated 4 credentials from "Claude Code-credentials" to "claude-max-proxy-credentials"
```

After migration, the two services drift independently. You can force the
migration to run again with:

```sh
node ~/projects/claude-max-proxy/agent/dist/index.js migrate
```

(It is idempotent and a no-op when the new service is non-empty.)

## Disabling an account temporarily

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/disable
```

Re-enable:

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/enable
```

The manually-disabled flag is in-memory; an agent restart clears it.

## Allowlisting accounts

Set `CLAUDE_MAX_ACCOUNTS=<email1>,<email2>` in the agent's launchd plist
to restrict the pool to a subset without removing the Keychain entries.

## Removing an account permanently

```sh
security delete-generic-password -s "claude-max-proxy-credentials" -a "<email>"
```

The watcher's next tick drops it from the pool.

## SSH / headless caveat

`agent login` opens a browser via `open` on macOS. If you're on an SSH
session into the Mac, `open` will run on the remote display (no browser
opens locally). Either run `agent login` from a graphical session, or
SSH-tunnel the random port the callback server picks and complete the
flow from a browser on your workstation.
