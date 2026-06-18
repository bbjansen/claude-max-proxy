import { describe, it, expect } from "vitest";
import { modelTierOf, retryAfterMs } from "../src/tier.js";

describe("modelTierOf", () => {
  it("maps known model families", () => {
    expect(modelTierOf("claude-opus-4-8")).toBe("opus");
    expect(modelTierOf("claude-opus-4-7-20251001")).toBe("opus");
    expect(modelTierOf("claude-sonnet-4-6")).toBe("sonnet");
    expect(modelTierOf("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("falls through to 'other' for unknown / missing model", () => {
    expect(modelTierOf("gpt-4")).toBe("other");
    expect(modelTierOf("")).toBe("other");
    expect(modelTierOf(undefined)).toBe("other");
    expect(modelTierOf(null)).toBe("other");
  });
});

describe("retryAfterMs", () => {
  const now = 1_700_000_000_000;
  const fiveMin = 5 * 60_000;
  const oneHour = 60 * 60_000;

  function res(headers: Record<string, string>): Response {
    return new Response(null, { status: 429, headers });
  }

  it("parses integer seconds", () => {
    expect(retryAfterMs(res({ "retry-after": "30" }), now)).toBe(30_000);
  });

  it("parses HTTP-date relative to now", () => {
    const future = new Date(now + 90_000).toUTCString();
    const got = retryAfterMs(res({ "retry-after": future }), now);
    expect(Math.abs(got - 90_000)).toBeLessThanOrEqual(1000);
  });

  it("clamps to 1 hour upper bound", () => {
    expect(retryAfterMs(res({ "retry-after": "999999" }), now)).toBe(oneHour);
  });

  it("clamps negative deltas (date already passed) to 0", () => {
    const past = new Date(now - 10_000).toUTCString();
    expect(retryAfterMs(res({ "retry-after": past }), now)).toBe(0);
  });

  it("falls back to default when header is missing", () => {
    expect(retryAfterMs(res({}), now)).toBe(fiveMin);
  });

  it("falls back to default when header is malformed", () => {
    expect(retryAfterMs(res({ "retry-after": "garbage!!" }), now)).toBe(fiveMin);
  });

  it("honors the explicit default override", () => {
    expect(retryAfterMs(res({}), now, 10_000)).toBe(10_000);
  });
});
