import * as jose from "jose";
import {
  openaiToAnthropic,
  anthropicToOpenai,
  anthropicSseToOpenaiSse,
  modelsList,
  type OpenAIChatRequest,
  type AnthropicMessageResponse,
} from "./openai-shim.js";

export interface Env {
  TUNNEL_HOSTNAME: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TUNNEL_ACCESS_CLIENT_ID: string;
  TUNNEL_ACCESS_CLIENT_SECRET: string;
  // Optional shared-bearer fallback for inbound auth, used when CF Access is
  // not (yet) configured in front of the Worker. When CF Access is in place,
  // requests carry Cf-Access-Jwt-Assertion and this is unused.
  PROXY_KEY?: string;
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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function authorize(req: Request, env: Env, skip: boolean): Promise<Response | null> {
  if (skip) return null;
  const jwt = req.headers.get("cf-access-jwt-assertion");
  const bearer = req.headers.get("authorization");
  const expectedBearer = env.PROXY_KEY ? `Bearer ${env.PROXY_KEY}` : null;
  const bearerOk = expectedBearer !== null && bearer !== null && timingSafeEqual(bearer, expectedBearer);
  if (jwt) {
    try { await verifyAccessJwt(jwt, env); return null; }
    catch (e) { return jsonResponse(403, { error: { type: "forbidden", message: `jwt invalid: ${(e as Error).message}` } }); }
  }
  if (!bearerOk) return jsonResponse(403, { error: { type: "forbidden", message: "missing access jwt or proxy bearer" } });
  return null;
}

function buildTunnelHeaders(req: Request, env: Env): Headers {
  const fwd = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) fwd.set(k, v);
  }
  if (env.TUNNEL_ACCESS_CLIENT_ID && env.TUNNEL_ACCESS_CLIENT_SECRET) {
    fwd.set("cf-access-client-id", env.TUNNEL_ACCESS_CLIENT_ID);
    fwd.set("cf-access-client-secret", env.TUNNEL_ACCESS_CLIENT_SECRET);
  }
  return fwd;
}

async function callTunnel(env: Env, body: BodyInit | null, headers: Headers): Promise<Awaited<ReturnType<typeof fetch>> | { error: string }> {
  try {
    return await fetch(`https://${env.TUNNEL_HOSTNAME}/v1/messages`, { method: "POST", headers, body });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function passThroughResponse(upstream: Awaited<ReturnType<typeof fetch>>): Response {
  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    outHeaders.set(k, v);
  }
  return new Response(
    upstream.body as unknown as ReadableStream<Uint8Array> | null,
    { status: upstream.status, headers: outHeaders },
  );
}

async function handleAnthropicMessages(req: Request, env: Env): Promise<Response> {
  const headers = buildTunnelHeaders(req, env);
  const upstream = await callTunnel(env, req.body, headers);
  if ("error" in upstream) return jsonResponse(502, { error: { type: "upstream_unavailable", message: upstream.error } });
  return passThroughResponse(upstream);
}

async function handleChatCompletions(req: Request, env: Env): Promise<Response> {
  let openaiReq: OpenAIChatRequest;
  try { openaiReq = await req.json() as OpenAIChatRequest; }
  catch { return jsonResponse(400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } }); }

  const anthropicBody = openaiToAnthropic(openaiReq);
  const stream = anthropicBody.stream === true;

  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  if (env.TUNNEL_ACCESS_CLIENT_ID && env.TUNNEL_ACCESS_CLIENT_SECRET) {
    headers.set("cf-access-client-id", env.TUNNEL_ACCESS_CLIENT_ID);
    headers.set("cf-access-client-secret", env.TUNNEL_ACCESS_CLIENT_SECRET);
  }

  const upstream = await callTunnel(env, JSON.stringify(anthropicBody), headers);
  if ("error" in upstream) return jsonResponse(502, { error: { type: "upstream_unavailable", message: upstream.error } });

  if (!upstream.ok) {
    // Forward Anthropic errors verbatim — clients can decode either format.
    return passThroughResponse(upstream);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  if (stream) {
    if (!upstream.body) return jsonResponse(502, { error: { type: "upstream_unavailable", message: "no body" } });
    const translated = anthropicSseToOpenaiSse(
      upstream.body as unknown as ReadableStream<Uint8Array>,
      openaiReq.model,
      nowSec,
    );
    return new Response(
      translated as unknown as ReadableStream<Uint8Array>,
      { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    );
  }

  const anthResp = await upstream.json() as AnthropicMessageResponse;
  return jsonResponse(200, anthropicToOpenai(anthResp, nowSec));
}

const handler = {
  __skipJwtVerify: false as boolean,

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // GET /v1/models is read-only; gated like everything else for simplicity.
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return jsonResponse(200, modelsList(Math.floor(Date.now() / 1000)));
    }

    if (req.method !== "POST") {
      return jsonResponse(404, { error: { type: "not_found", message: "POST /v1/messages, POST /v1/chat/completions, GET /v1/models, or POST /v1/embeddings" } });
    }

    if (url.pathname === "/v1/embeddings") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return jsonResponse(501, {
        error: {
          type: "not_implemented",
          message: "Anthropic does not provide embeddings via this API. Configure a separate provider (OpenAI text-embedding-3-*, Voyage, local Ollama, etc.) for embeddings.",
        },
      });
    }

    if (url.pathname === "/v1/messages") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return handleAnthropicMessages(req, env);
    }

    if (url.pathname === "/v1/chat/completions") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return handleChatCompletions(req, env);
    }

    return jsonResponse(404, { error: { type: "not_found", message: "unknown route" } });
  },
};

export default handler;
