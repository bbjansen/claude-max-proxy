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
import { runLogin } from "./login.js";
import { runMigrationOnce } from "./migrate.js";
import type { AccountId, OAuthCredential } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOCK_PATH = path.join(os.homedir(), ".claude", ".proxy-refresh.lock");
const NEW_SERVICE = "claude-max-proxy-credentials";
const OLD_SERVICE = "Claude Code-credentials";

function allowlistFromEnv(): Set<AccountId> | null {
  const raw = process.env.CLAUDE_MAX_ACCOUNTS;
  if (!raw) return null;
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
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

async function listKeychainAccounts(service: string): Promise<AccountId[]> {
  const { stdout, code } = await runSecurity(["dump-keychain"]);
  if (code !== 0) return [];
  const ids = new Set<AccountId>();
  let svceMatch = false;
  let acctVal: string | null = null;
  for (const line of stdout.split("\n")) {
    const svce = line.match(/"svce"<blob>="([^"]*)"/);
    if (svce) { svceMatch = svce[1] === service; }
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
}

function newServiceEnumerator(): KeychainEnumerator {
  return {
    list: () => listKeychainAccounts(NEW_SERVICE),
    async read(acctId) {
      try { return await new KeychainStore(acctId).read(); }
      catch { return null; }
    },
  };
}

function makeManager(acctId: AccountId): TokenManager {
  return new TokenManager(
    new KeychainStore(acctId),
    new PlatformRefreshClient(),
    makeFileLock(LOCK_PATH),
  );
}

async function migrateLegacyService(): Promise<void> {
  await runMigrationOnce({
    listOld: () => listKeychainAccounts(OLD_SERVICE),
    readOld: async (acctId): Promise<OAuthCredential | null> => {
      const r = await runSecurity(["find-generic-password", "-s", OLD_SERVICE, "-a", acctId, "-w"]);
      if (r.code !== 0) return null;
      try {
        const j = JSON.parse(r.stdout.trim()) as { claudeAiOauth?: Record<string, unknown> } | null;
        const o = j?.claudeAiOauth;
        if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string" || typeof o.expiresAt !== "number") return null;
        const scopes = Array.isArray(o.scopes)
          ? (o.scopes as unknown[]).filter((s): s is string => typeof s === "string")
          : [];
        return {
          accessToken: o.accessToken,
          refreshToken: o.refreshToken,
          expiresAt: o.expiresAt,
          scopes,
        };
      } catch { return null; }
    },
    listNew: () => listKeychainAccounts(NEW_SERVICE),
    writeNew: async (acctId, cred) => { await new KeychainStore(acctId).write(cred); },
    log: (m) => console.log(m),
  });
}

async function runServer(): Promise<void> {
  await migrateLegacyService();

  const pool = new AccountPool([]);
  const watcher = new KeychainWatcher({
    enumerator: newServiceEnumerator(),
    factory: makeManager,
    pool,
    allowlist: allowlistFromEnv(),
    intervalMs: 5_000,
    log: (msg, extra) => console.warn(`[agent] ${msg}`, extra ?? ""),
  });

  await watcher.tick();
  if (pool.accounts().length === 0) {
    console.error(`[agent] no Max-account Keychain entries discovered under service '${NEW_SERVICE}'. ` +
      "Run 'agent login --acct <email>' to capture one " +
      "(see docs/operations/capturing-multi-account-credentials.md).");
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

async function runLoginSubcommand(args: string[]): Promise<void> {
  let acctId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--acct") {
      acctId = args[i + 1] ?? null;
      i++;
    }
  }
  if (!acctId) {
    console.error("usage: agent login --acct <email>");
    process.exit(64);
  }
  await runLogin(acctId, {
    openBrowser: async (url) => {
      console.log(`[agent] opening browser → ${url}`);
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    },
    writeCredential: async (id, cred) => { await new KeychainStore(id).write(cred); },
    log: (m) => console.log(m),
  });
}

async function runMigrateSubcommand(): Promise<void> {
  await migrateLegacyService();
}

function printUsage(): void {
  console.error(
    "usage:\n" +
    "  agent                      # run the proxy server (default)\n" +
    "  agent login --acct <email> # capture a new Max account via PKCE\n" +
    "  agent migrate              # copy legacy 'Claude Code-credentials' into self-owned service\n"
  );
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case undefined:
      return runServer();
    case "login":
      return runLoginSubcommand(rest);
    case "migrate":
      return runMigrateSubcommand();
    case "-h":
    case "--help":
      printUsage();
      return;
    default:
      printUsage();
      process.exit(64);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
