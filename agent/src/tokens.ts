import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { lock as lockfile } from "proper-lockfile";
import type { AcquireLock, CredentialStore, OAuthCredential, RefreshClient } from "./types.js";

const REFRESH_THRESHOLD_MS = 60_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_EXPIRES_IN_S = 8 * 3600;

export class TokenManager {
  private cached: OAuthCredential | null = null;
  private inflight: Promise<OAuthCredential> | null = null;

  constructor(
    private readonly store: CredentialStore,
    private readonly refresher: RefreshClient,
    private readonly acquireLock: AcquireLock,
    private readonly clock: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (!this.cached) this.cached = await this.store.read();
    if (!this.cached) throw new Error("no credential available — run `claude` to log in");
    if (this.cached.expiresAt - this.clock() < REFRESH_THRESHOLD_MS) {
      this.cached = await this.refreshShared(false);
    }
    return this.cached.accessToken;
  }

  async forceRefresh(): Promise<string> {
    this.cached = await this.refreshShared(true);
    return this.cached.accessToken;
  }

  private async refreshShared(force: boolean): Promise<OAuthCredential> {
    if (this.inflight) return this.inflight;
    this.inflight = this.refreshLocked(force);
    try { return await this.inflight; }
    finally { this.inflight = null; }
  }

  private async refreshLocked(force: boolean): Promise<OAuthCredential> {
    const release = await this.acquireLock();
    try {
      const fresh = await this.store.read();
      if (!force && fresh && fresh.expiresAt - this.clock() >= REFRESH_THRESHOLD_MS) {
        return fresh;
      }
      const seed = fresh ?? this.cached;
      if (!seed) throw new Error("no credential available to refresh");
      const refreshed = await this.refresher.refresh(seed.refreshToken);
      await this.store.write(refreshed);
      return refreshed;
    } finally {
      await release();
    }
  }
}

export class KeychainStore implements CredentialStore {
  constructor(private readonly account: string = os.userInfo().username) {}

  async read(): Promise<OAuthCredential | null> {
    const { stdout, code } = await runSecurity(
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w"]
    );
    if (code === 44 || code === 51) return null;
    if (code !== 0) throw new Error(`security read failed (exit ${code})`);
    return parseCredential(stdout.trim());
  }

  async write(cred: OAuthCredential): Promise<void> {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        scopes: cred.scopes,
      },
    });
    const { code } = await runSecurity(
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w", json]
    );
    if (code !== 0) throw new Error(`security write failed (exit ${code})`);
  }
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly file: string = path.join(os.homedir(), ".claude", ".credentials.json")) {}

  async read(): Promise<OAuthCredential | null> {
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      return parseCredential(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(cred: OAuthCredential): Promise<void> {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        scopes: cred.scopes,
      },
    }, null, 2);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, json, { mode: 0o600 });
  }
}

function parseCredential(raw: string): OAuthCredential {
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch { throw new Error("credential payload is not JSON"); }
  const o = (json as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string" || typeof o.expiresAt !== "number") {
    throw new Error("credential payload missing required fields");
  }
  const scopes = Array.isArray(o.scopes)
    ? (o.scopes as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    expiresAt: o.expiresAt,
    scopes,
  };
}

export class PlatformRefreshClient implements RefreshClient {
  async refresh(refreshToken: string): Promise<OAuthCredential> {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`refresh ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json() as Record<string, unknown>;
    if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
      throw new Error("refresh response missing tokens");
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : DEFAULT_EXPIRES_IN_S;
    const scope = typeof json.scope === "string" ? json.scope : "";
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
      scopes: scope.split(" ").filter(Boolean),
    };
  }
}

export function makeFileLock(filePath: string): AcquireLock {
  return async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "", { flag: "a" });
    return lockfile(filePath, {
      retries: { retries: 40, factor: 1, minTimeout: 250, maxTimeout: 250 },
      stale: 10_000,
    });
  };
}

interface SecurityResult { stdout: string; stderr: string; code: number; }

function runSecurity(args: string[]): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}
