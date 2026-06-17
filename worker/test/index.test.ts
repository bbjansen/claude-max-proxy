import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";

const ENV_BASE = {
  TUNNEL_HOSTNAME: "tunnel.example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
  TUNNEL_ACCESS_CLIENT_ID: "cid",
  TUNNEL_ACCESS_CLIENT_SECRET: "csecret",
};

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (worker as unknown as { __skipJwtVerify: boolean }).__skipJwtVerify = true;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (worker as unknown as { __skipJwtVerify: boolean }).__skipJwtVerify = false;
});

describe("worker fetch handler", () => {
  it("returns 404 for non-matching routes", async () => {
    const req = new Request("https://w.example.com/health", { method: "GET" });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(404);
  });

  it("returns 403 when no Access JWT is present", async () => {
    (worker as unknown as { __skipJwtVerify: boolean }).__skipJwtVerify = false;
    const req = new Request("https://w.example.com/v1/messages", { method: "POST", body: "{}" });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(403);
  });

  it("forwards POST /v1/messages to the tunnel and streams response back", async () => {
    fetchMock.mockResolvedValueOnce(new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }));
    const req = new Request("https://w.example.com/v1/messages", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "stub", "content-type": "application/json" },
      body: '{"messages":[]}',
    });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://tunnel.example.com/v1/messages");
    const init = call[1] as RequestInit;
    const h = new Headers(init.headers as HeadersInit);
    expect(h.get("cf-access-client-id")).toBe("cid");
    expect(h.get("cf-access-client-secret")).toBe("csecret");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("returns 502 when the tunnel fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    const req = new Request("https://w.example.com/v1/messages", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "stub", "content-type": "application/json" },
      body: "{}",
    });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("upstream_unavailable");
  });
});
