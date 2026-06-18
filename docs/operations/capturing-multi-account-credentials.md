# Capturing multiple Max-account OAuth credentials

The proxy agent rotates across every Keychain entry under service
`Claude Code-credentials` whose `acct` field is a stable account ID
(typically the Max-account email). The stock `claude` CLI writes ONE
entry under `acct = $(id -un)` and overwrites it on every login, so
capturing N accounts is a small manual dance.

## One-time setup per account

For each Max-account email:

1. Log out of any current session:
   ```sh
   claude logout
   ```
2. Log in as the new account:
   ```sh
   claude
   ```
   Complete the browser flow.
3. Promote the just-written Keychain entry to its stable name:
   ```sh
   scripts/capture-max-account.sh bob.jansen@pm.me
   ```
   Replace the argument with the email of the account you just logged in
   with. The script reads the default-named entry, re-stores it under
   `acct=<email>`, and deletes the default so the next `claude` login
   starts clean.

After all accounts are captured, this command should list one `acct`
line per Max email:

```sh
security dump-keychain | grep -B1 'Claude Code-credentials'
```

## Verifying the agent sees them

Within 5 seconds of any new entry appearing, the agent's
`KeychainWatcher` reconciles the pool. Check via the admin endpoint:

```sh
curl -sS http://127.0.0.1:8787/v1/admin/accounts | jq '.accounts[].acct_id'
```

## Disabling an account temporarily

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/disable
```

Re-enable:

```sh
curl -X POST http://127.0.0.1:8787/v1/admin/accounts/<email>/enable
```

The manual-disable flag is in-memory only; an agent restart clears it.

## Allowlisting accounts

Set `CLAUDE_MAX_ACCOUNTS=<email1>,<email2>` in the agent's launchd plist
to restrict the pool to a subset, without removing the Keychain
entries. Useful for temporarily routing around a broken account.

## Removing an account permanently

Delete the Keychain entry directly:

```sh
security delete-generic-password -s "Claude Code-credentials" -a "<email>"
```

The watcher's next tick drops it from the pool.
