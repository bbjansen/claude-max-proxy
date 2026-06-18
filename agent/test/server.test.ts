import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.js";
import { AccountPool } from "../src/pool.js";

function poolWith(...entries: Array<{ acctId: string; token: string }>) {
  return new AccountPool(entries.map(e => ({
    acctId: e.acctId,
    manager: {
      async getAccessToken() { return e.token; },
      async forceRefresh() { return e.token; },
      adoptExternalCredential() {},
    } as never,
  })), { clock: () => 1_700_000_000_000 });
}

function startServer(deps: Parameters<typeof createServer>[0]) {
  const server = createServer(deps);
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
  it("POST /v1/messages routes through the rotating upstream and pipes the response", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const upstreamFake = vi.fn(async () => new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }));
    const { server, url } = await startServer({ pool, upstream: upstreamFake });
    try {
      const r = await post(`${url}/v1/messages`, JSON.stringify({ model: "claude-haiku-4-5" }));
      expect(r.status).toBe(200);
      expect(r.body).toBe("hi");
      expect(upstreamFake).toHaveBeenCalledTimes(1);
    } finally { server.close(); }
  });

  it("POST /v1/messages with non-JSON body returns 400", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("ok") });
    try {
      const r = await post(`${url}/v1/messages`, "not-json");
      expect(r.status).toBe(400);
    } finally { server.close(); }
  });

  it("GET /v1/admin/accounts returns the snapshot", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("") });
    try {
      const res = await fetch(`${url}/v1/admin/accounts`);
      expect(res.status).toBe(200);
      const body = await res.json() as { accounts: Array<{ acct_id: string }> };
      expect(body.accounts.map(a => a.acct_id)).toEqual(["a@x"]);
    } finally { server.close(); }
  });

  it("POST /v1/admin/accounts/{id}/disable + /enable flip and persist", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("") });
    try {
      let res = await fetch(`${url}/v1/admin/accounts/a%40x/disable`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(pool.isManuallyDisabled("a@x")).toBe(true);
      res = await fetch(`${url}/v1/admin/accounts/a%40x/enable`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(pool.isManuallyDisabled("a@x")).toBe(false);
    } finally { server.close(); }
  });

  it("unknown route returns 404", async () => {
    const pool = poolWith({ acctId: "a@x", token: "tA" });
    const { server, url } = await startServer({ pool, upstream: async () => new Response("") });
    try {
      const r = await post(`${url}/unknown`, "{}");
      expect(r.status).toBe(404);
    } finally { server.close(); }
  });
});
