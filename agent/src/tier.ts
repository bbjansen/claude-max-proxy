import type { ModelTier } from "./types.js";

const FIVE_MIN_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export function modelTierOf(model: string | undefined | null): ModelTier {
  if (!model) return "other";
  if (model.startsWith("claude-opus-")) return "opus";
  if (model.startsWith("claude-sonnet-")) return "sonnet";
  if (model.startsWith("claude-haiku-")) return "haiku";
  return "other";
}

export function retryAfterMs(response: Response, nowMs: number, defaultMs = FIVE_MIN_MS): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return defaultMs;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return clamp(Number(trimmed) * 1000);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return clamp(parsed - nowMs);
  }
  return defaultMs;
}

function clamp(ms: number): number {
  if (ms < 0) return 0;
  if (ms > ONE_HOUR_MS) return ONE_HOUR_MS;
  return ms;
}
