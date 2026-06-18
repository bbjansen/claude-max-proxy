import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callUpstream, callUpstreamRotating } from "../src/upstream.js";
import { AccountPool } from "../src/pool.js";

class FakeTokens {
  public refreshes = 0;
  public getCalls = 0;
  constructor(private accessTokens: string[]) {}
  async getAccessToken(): Promise<string> {
    this.getCalls++;
    return this.accessTokens[Math.min(this.getCalls - 1, this.accessTokens.length - 1)]!;
  }
  async forceRefresh(): Promise<string> {
    this.refreshes++;
    return this.accessTokens[Math.min(this.getCalls, this.accessTokens.length - 1)]!;
  }
}

describe("callUpstream", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sends required OAuth headers and forwards body verbatim", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const tokens = new FakeTokens(["tok-A"]);
    const body = Buffer.from('{"messages":[]}');
    const res = await callUpstream(body, "text/event-stream", tokens as never);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const url = call[0];
    const init = call[1] as RequestInit;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    const h = new Headers(init.headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer tok-A");
    expect(h.get("anthropic-beta")).toBe("oauth-2025-04-20,claude-code-20250219");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("x-app")).toBe("cli");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("accept")).toBe("text/event-stream");
  });

  it("retries once on 401 after forceRefresh and uses the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const tokens = new FakeTokens(["tok-OLD", "tok-NEW"]);
    const res = await callUpstream(Buffer.from("{}"), "application/json", tokens as never);

    expect(res.status).toBe(200);
    expect(tokens.refreshes).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth0 = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers as HeadersInit).get("authorization");
    const auth1 = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers as HeadersInit).get("authorization");
    expect(auth0).toBe("Bearer tok-OLD");
    expect(auth1).toBe("Bearer tok-NEW");
  });

  it("returns 401 to caller if retry also fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("still nope", { status: 401 }));
    const tokens = new FakeTokens(["tok-OLD", "tok-NEW"]);
    const res = await callUpstream(Buffer.from("{}"), "application/json", tokens as never);

    expect(res.status).toBe(401);
    expect(tokens.refreshes).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards non-401 errors without retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate", { status: 429, headers: { "retry-after": "5" } }));
    const tokens = new FakeTokens(["tok-A"]);
    const res = await callUpstream(Buffer.from("{}"), "application/json", tokens as never);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens.refreshes).toBe(0);
  });
});

describe("callUpstreamRotating", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function poolOf(...entries: Array<{ acctId: string; token: string }>) {
    return new AccountPool(entries.map(e => ({
      acctId: e.acctId,
      manager: {
        async getAccessToken() { return e.token; },
        async forceRefresh() { return e.token; },
        adoptExternalCredential() {},
      } as never,
    })), { clock: () => 1_700_000_000_000 });
  }

  it("on 429 from account A, retries with account B and returns B's response", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
        { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const pool = poolOf({ acctId: "a@x", token: "tok-A" }, { acctId: "b@y", token: "tok-B" });
    const body = Buffer.from(JSON.stringify({ model: "claude-opus-4-7" }));
    const res = await callUpstreamRotating(body, "application/json", pool);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth1 = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers as HeadersInit).get("authorization");
    const auth2 = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers as HeadersInit).get("authorization");
    expect(auth1).toBe("Bearer tok-A");
    expect(auth2).toBe("Bearer tok-B");
  });

  it("caps at 3 total attempts and returns the last 429 to the client", async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
      { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
    ));
    const pool = poolOf(
      { acctId: "a@x", token: "tok-A" },
      { acctId: "b@y", token: "tok-B" },
      { acctId: "c@z", token: "tok-C" },
      { acctId: "d@w", token: "tok-D" },
    );
    const body = Buffer.from(JSON.stringify({ model: "claude-opus-4-7" }));
    const res = await callUpstreamRotating(body, "application/json", pool);
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not fail over on non-429 errors (4xx / 5xx pass through)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    const pool = poolOf({ acctId: "a@x", token: "tok-A" }, { acctId: "b@y", token: "tok-B" });
    const body = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5" }));
    const res = await callUpstreamRotating(body, "application/json", pool);
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards accountHint to pool.pickToken on the first attempt only", async () => {
    fetchMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    const acctIds = ["a@x", "b@y"];
    const calls: Array<{ tier: string; exclude: string[]; hint: string | null }> = [];
    const pool = {
      pickToken: async (tier: string, exclude: string[], hint: string | null = null) => {
        calls.push({ tier, exclude: [...exclude], hint });
        return { acctId: acctIds[exclude.length] ?? "a@x", token: "t" };
      },
      markCooldown: () => {},
      accounts: () => acctIds,
    } as unknown as AccountPool;

    const body = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5" }));
    await callUpstreamRotating(body, "application/json", pool, { accountHint: "b@y" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.hint).toBe("b@y");
  });

  it("drops accountHint on 429 retry", async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "" } }),
      { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
    ));
    const acctIds = ["a@x", "b@y", "c@z"];
    const calls: Array<{ hint: string | null }> = [];
    const pool = {
      pickToken: async (_tier: string, exclude: string[], hint: string | null = null) => {
        calls.push({ hint });
        return { acctId: acctIds[exclude.length] ?? "a@x", token: "t" };
      },
      markCooldown: () => {},
      accounts: () => acctIds,
    } as unknown as AccountPool;

    const body = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5" }));
    await callUpstreamRotating(body, "application/json", pool, { accountHint: "b@y" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.hint).toBe("b@y");
    expect(calls[1]!.hint).toBeNull();
  });
});
