import * as jose from "jose";

export interface Env {
  TUNNEL_HOSTNAME: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TUNNEL_ACCESS_CLIENT_ID: string;
  TUNNEL_ACCESS_CLIENT_SECRET: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "cookie",
]);

const FORWARD_HEADERS = new Set([
  "accept",
  "content-type",
  "anthropic-version",
]);

const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let getKey = jwksCache.get(teamDomain);
  if (!getKey) {
    getKey = jose.createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, getKey);
  }
  return getKey;
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<void> {
  await jose.jwtVerify(jwt, getJwks(env.ACCESS_TEAM_DOMAIN), {
    audience: env.ACCESS_AUD,
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const handler = {
  __skipJwtVerify: false as boolean,

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      return jsonResponse(404, { error: { type: "not_found", message: "POST /v1/messages only" } });
    }

    const jwt = req.headers.get("cf-access-jwt-assertion");
    if (!handler.__skipJwtVerify) {
      if (!jwt) return jsonResponse(403, { error: { type: "forbidden", message: "missing access jwt" } });
      try { await verifyAccessJwt(jwt, env); }
      catch (e) {
        return jsonResponse(403, { error: { type: "forbidden", message: `jwt invalid: ${(e as Error).message}` } });
      }
    }

    const fwdHeaders = new Headers();
    for (const [k, v] of req.headers.entries()) {
      if (FORWARD_HEADERS.has(k.toLowerCase())) fwdHeaders.set(k, v);
    }
    fwdHeaders.set("cf-access-client-id", env.TUNNEL_ACCESS_CLIENT_ID);
    fwdHeaders.set("cf-access-client-secret", env.TUNNEL_ACCESS_CLIENT_SECRET);

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`https://${env.TUNNEL_HOSTNAME}/v1/messages`, {
        method: "POST",
        headers: fwdHeaders,
        body: req.body,
      });
    } catch (e) {
      return jsonResponse(502, { error: { type: "upstream_unavailable", message: (e as Error).message } });
    }

    const outHeaders = new Headers();
    for (const [k, v] of upstream.headers.entries()) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      outHeaders.set(k, v);
    }
    return new Response(
      upstream.body as unknown as ReadableStream<Uint8Array> | null,
      { status: upstream.status, headers: outHeaders },
    );
  },
};

export default handler;
