import type { TokenManager } from "./tokens.js";
import type { AccountPool } from "./pool.js";
import { modelTierOf, retryAfterMs } from "./tier.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_ATTEMPTS_DEFAULT = 3;
// A 401 from Anthropic means the OAuth refresh chain for this account is
// broken (revoked refresh token, IdP-side invalidation, etc.). Pull the
// account out of rotation for long enough that bursts of traffic don't
// keep hitting it, but not so long that an OAuth-recovery via re-login is
// invisible. 15 min matches typical Anthropic refresh propagation.
const COOLDOWN_401_MS = 15 * 60 * 1000;

interface RotatingOpts {
  maxAttempts?: number;
  nowMs?: () => number;
  log?: (msg: string, extra?: object) => void;
  accountHint?: string | null;
}

export async function callUpstream(
  body: Buffer,
  acceptHeader: string,
  tokens: TokenManager,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = attempt === 0 ? await tokens.getAccessToken() : await tokens.forceRefresh();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-version": "2023-06-01",
        "x-app": "cli",
        "content-type": "application/json",
        "user-agent": "claude-max-proxy/0.1",
        accept: acceptHeader || "application/json",
      },
      body,
    });
    if (res.status !== 401 || attempt === 1) return res;
  }
  throw new Error("unreachable");
}

export async function callUpstreamRotating(
  body: Buffer,
  acceptHeader: string,
  pool: AccountPool,
  opts: RotatingOpts = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const log = opts.log ?? (() => {});

  let model: string | undefined;
  try { model = JSON.parse(body.toString("utf-8"))?.model; }
  catch { /* tier resolves to "other" */ }
  const tier = modelTierOf(model ?? null);

  const tried: string[] = [];
  let lastResponse: Response | null = null;
  const initialHint = opts.accountHint ?? null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const hint = attempt === 0 ? initialHint : null;
    const { acctId, token } = await pool.pickToken(tier, tried, hint);
    tried.push(acctId);

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-version": "2023-06-01",
        "x-app": "cli",
        "content-type": "application/json",
        "user-agent": "claude-max-proxy/0.2",
        accept: acceptHeader || "application/json",
      },
      body,
    });

    if (res.status === 401) {
      pool.markCooldown(acctId, tier, nowMs() + COOLDOWN_401_MS);
      log("upstream: 401; cooled and rotating", { acctId, tier, cooldownMs: COOLDOWN_401_MS });
      lastResponse = res;
      continue;
    }

    if (res.status !== 429) {
      log("upstream: response", { acctId, tier, status: res.status });
      return res;
    }

    const text = await res.text();
    let isRateLimit = false;
    try { isRateLimit = JSON.parse(text)?.error?.type === "rate_limit_error"; }
    catch { isRateLimit = true; }

    const replay = new Response(text, { status: res.status, headers: res.headers });
    lastResponse = replay;

    if (isRateLimit) {
      const cooldown = retryAfterMs(res, nowMs());
      pool.markCooldown(acctId, tier, nowMs() + cooldown);
      log("upstream: rate-limit; cooled", { acctId, tier, cooldownMs: cooldown });
      continue;
    }

    return replay;
  }

  return lastResponse!;
}
