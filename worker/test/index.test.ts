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
  return { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
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

describe("worker routing", () => {
  it("returns 404 for unknown route", async () => {
    const req = new Request("https://w.example.com/health", { method: "GET" });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(404);
  });

  it("returns 403 on POST /v1/messages without auth", async () => {
    (worker as unknown as { __skipJwtVerify: boolean }).__skipJwtVerify = false;
    const req = new Request("https://w.example.com/v1/messages", { method: "POST", body: "{}" });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(403);
  });

  it("forwards POST /v1/messages to the tunnel verbatim", async () => {
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

  it("returns a non-empty model list on GET /v1/models", async () => {
    const req = new Request("https://w.example.com/v1/models", { method: "GET" });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("returns 501 with a clear not_implemented error on POST /v1/embeddings", async () => {
    const req = new Request("https://w.example.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hi","model":"x"}',
    });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(501);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("not_implemented");
    expect(body.error.message).toMatch(/Anthropic does not provide embeddings/);
  });

  it("translates POST /v1/chat/completions non-streaming and forwards to tunnel as /v1/messages", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "msg_abc", type: "message", role: "assistant", model: "claude-haiku-4-5",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const req = new Request("https://w.example.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [
          { role: "system", content: "You are X." },
          { role: "user", content: "hi" },
        ],
        max_tokens: 16,
      }),
    });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown> & { choices: Array<Record<string, unknown>> };
    expect(body.object).toBe("chat.completion");
    expect(body.id).toBe("chatcmpl-abc");
    const msg = (body.choices[0] as Record<string, unknown>).message as { role: string; content: string };
    expect(msg.content).toBe("hello");

    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://tunnel.example.com/v1/messages");
    const init = call[1] as RequestInit;
    const forwarded = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(forwarded.model).toBe("claude-haiku-4-5");
    expect(forwarded.system).toBe("You are X.");
    expect(forwarded.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(forwarded.max_tokens).toBe(16);
  });
});
