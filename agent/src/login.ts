import { generatePkcePair, generateState, buildAuthorizeUrl, exchangeCodeForTokens, startCallbackServer } from "./oauth.js";
import type { OAuthCredential, AccountId } from "./types.js";

export interface LoginDeps {
  openBrowser?: (url: string) => Promise<void>;
  writeCredential: (acctId: AccountId, cred: OAuthCredential) => Promise<void>;
  log?: (msg: string) => void;
  nowMs?: () => number;
  portHint?: number;
}

export async function runLogin(acctId: AccountId, deps: LoginDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const { verifier, challenge } = generatePkcePair();
  const state = generateState();
  const srv = await startCallbackServer(state, { port: deps.portHint ?? 0 });
  try {
    const authorizeUrl = buildAuthorizeUrl(challenge, state, srv.redirectUri);
    if (deps.openBrowser) {
      await deps.openBrowser(authorizeUrl);
    } else {
      log(`[agent] please open this URL in a browser:\n  ${authorizeUrl}`);
    }
    const { code } = await srv.result;
    const cred = await exchangeCodeForTokens(code, verifier, srv.redirectUri, { nowMs: deps.nowMs });
    await deps.writeCredential(acctId, cred);
    log(`[agent] login successful for ${acctId}`);
  } finally {
    srv.close();
  }
}
