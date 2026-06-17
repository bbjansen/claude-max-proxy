import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "./server.js";
import { callUpstream } from "./upstream.js";
import {
  KeychainStore,
  FileCredentialStore,
  PlatformRefreshClient,
  TokenManager,
  makeFileLock,
} from "./tokens.js";
import type { CredentialStore } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOCK_PATH = path.join(os.homedir(), ".claude", ".proxy-refresh.lock");

async function chooseStore(): Promise<CredentialStore> {
  const keychain = new KeychainStore();
  const probe = await keychain.read().catch(() => null);
  if (probe) return keychain;
  console.warn("[agent] no Keychain credential; falling back to ~/.claude/.credentials.json");
  return new FileCredentialStore();
}

async function main() {
  const store = await chooseStore();
  const tokens = new TokenManager(store, new PlatformRefreshClient(), makeFileLock(LOCK_PATH));
  try { await tokens.getAccessToken(); }
  catch (e) { console.error("[agent] credential check failed:", e); process.exitCode = 1; return; }

  const server = createServer({
    upstream: (body, accept) => callUpstream(body, accept, tokens),
  });
  server.listen(PORT, HOST, () => {
    console.log(`[agent] listening on http://${HOST}:${PORT}`);
  });

  const shutdown = (sig: string) => {
    console.log(`[agent] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => { console.error(e); process.exit(1); });
