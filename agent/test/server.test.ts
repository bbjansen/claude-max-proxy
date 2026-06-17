import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { createServer } from "../src/server.js";
import type { AddressInfo } from "node:net";

function startServer(upstream: (body: Buffer, accept: string) => Promise<Response>) {
  const server = createServer({ upstream });
  return new Promise<{ server: http.Server; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("createServer", () => {
  it("routes POST /v1/messages to upstream and streams body back", async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("chunk-1")); c.enqueue(new TextEncoder().encode("chunk-2")); c.close(); }
    });
    const upstream = async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, '{"messages":[]}');
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/event-stream");
      expect(r.body).toBe("chunk-1chunk-2");
    } finally { server.close(); }
  });

  it("returns 404 for non-matching routes", async () => {
    const upstream = async () => new Response("nope", { status: 200 });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/other`, "{}");
      expect(r.status).toBe(404);
      const j = JSON.parse(r.body);
      expect(j.error.type).toBe("not_found");
    } finally { server.close(); }
  });

  it("returns 400 on non-JSON body", async () => {
    const upstream = async () => new Response("ok", { status: 200 });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, "not-json");
      expect(r.status).toBe(400);
      const j = JSON.parse(r.body);
      expect(j.error.type).toBe("invalid_request_error");
    } finally { server.close(); }
  });

  it("forwards 4xx/5xx status and body from upstream", async () => {
    const upstream = async () => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
      status: 429,
      headers: { "retry-after": "3", "content-type": "application/json" },
    });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, "{}");
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("3");
      expect(JSON.parse(r.body).error.type).toBe("rate_limit_error");
    } finally { server.close(); }
  });

  it("strips hop-by-hop headers from upstream response", async () => {
    const upstream = async () => new Response("body", {
      status: 200,
      headers: { "content-type": "text/plain", "connection": "keep-alive", "transfer-encoding": "chunked" },
    });
    const { server, url } = await startServer(upstream);
    try {
      const r = await post(`${url}/v1/messages`, "{}");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/plain");
    } finally { server.close(); }
  });
});
