import type { TokenManager } from "./tokens.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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
