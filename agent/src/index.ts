import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { AccountPool } from "./pool.js";
import { KeychainWatcher, type KeychainEnumerator } from "./watcher.js";
import {
  KeychainStore,
  PlatformRefreshClient,
  TokenManager,
  makeFileLock,
} from "./tokens.js";
import { createServer } from "./server.js";
import { callUpstreamRotating } from "./upstream.js";
import type { AccountId, OAuthCredential } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOCK_PATH = path.join(os.homedir(), ".claude", ".proxy-refresh.lock");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function allowlistFromEnv(): Set<AccountId> | null {
  const raw = process.env.CLAUDE_MAX_ACCOUNTS;
  if (!raw) return null;
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return new Set(ids);
}

const realEnumerator: KeychainEnumerator = {
  async list(): Promise<AccountId[]> {
    const { stdout, code } = await runSecurity(["dump-keychain"]);
    if (code !== 0) return [];
    const ids = new Set<AccountId>();
    let svceMatch = false;
    let acctVal: string | null = null;
    for (const line of stdout.split("\n")) {
      const svce = line.match(/"svce"<blob>="([^"]*)"/);
      if (svce) { svceMatch = svce[1] === KEYCHAIN_SERVICE; }
      const acct = line.match(/"acct"<blob>="([^"]*)"/);
      if (acct) { acctVal = acct[1]!; }
      if (line.startsWith("class:") || line.startsWith("keychain:")) {
        if (svceMatch && acctVal) ids.add(acctVal);
        svceMatch = false;
        acctVal = null;
      }
    }
    if (svceMatch && acctVal) ids.add(acctVal);
    return [...ids];
  },
  async read(acctId: AccountId): Promise<OAuthCredential | null> {
    const store = new KeychainStore(acctId);
    try { return await store.read(); }
    catch { return null; }
  },
};

function makeManager(acctId: AccountId): TokenManager {
  return new TokenManager(
    new KeychainStore(acctId),
    new PlatformRefreshClient(),
    makeFileLock(LOCK_PATH),
  );
}

async function main() {
  const pool = new AccountPool([]);

  const watcher = new KeychainWatcher({
    enumerator: realEnumerator,
    factory: makeManager,
    pool,
    allowlist: allowlistFromEnv(),
    intervalMs: 5_000,
    log: (msg, extra) => console.warn(`[agent] ${msg}`, extra ?? ""),
  });

  await watcher.tick();
  if (pool.accounts().length === 0) {
    console.error(`[agent] no Max-account Keychain entries discovered under service '${KEYCHAIN_SERVICE}'. ` +
      "Capture at least one (see docs/operations/capturing-multi-account-credentials.md).");
    process.exit(1);
  }

  watcher.start();

  const server = createServer({
    pool,
    upstream: (body, accept, p) => callUpstreamRotating(body, accept, p, {
      log: (msg, extra) => console.log(`[agent] ${msg}`, extra ?? ""),
    }),
  });
  server.listen(PORT, HOST, () => {
    console.log(`[agent] listening on http://${HOST}:${PORT} (accounts: ${pool.accounts().join(", ")})`);
  });

  const shutdown = (sig: string) => {
    console.log(`[agent] ${sig} received, shutting down`);
    watcher.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

interface SecurityResult { stdout: string; code: number; }
function runSecurity(args: string[]): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout?.on("data", (b) => { stdout += b.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, code: code ?? -1 }));
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
