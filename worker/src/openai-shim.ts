// OpenAI Chat Completions ⇄ Anthropic Messages translation.
// v1 scope: text-only, streaming + non-streaming. Function/tool calls deferred.

const DEFAULT_MAX_TOKENS = 4096;

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content: string | Array<{ type: string; text?: string }> | null;
  name?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  response_format?: { type: string };
}

export interface AnthropicMessageContentBlock {
  type: string;
  text?: string;
}

export interface AnthropicMessageResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: AnthropicMessageContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface TranslationError {
  status: number;
  type: string;
  message: string;
}

export type TranslationResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: TranslationError };

export function openaiToAnthropic(req: OpenAIChatRequest): TranslationResult {
  if (!Array.isArray(req.messages)) {
    return err(400, "invalid_request_error", "`messages` must be an array");
  }

  let system: string | undefined;
  const messages: Array<{ role: string; content: string }> = [];

  for (const m of req.messages) {
    if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") {
      // tool/function roles are not supported in v1; surface explicitly rather than dropping.
      return err(400, "invalid_request_error",
        `role \`${m.role}\` is not supported by this proxy (text-only chat-completions shim)`);
    }
    const flat = flattenContent(m.content);
    if (!flat.ok) return err(400, "invalid_request_error", flat.error);
    if (m.role === "system") {
      system = system ? `${system}\n\n${flat.text}` : flat.text;
    } else {
      messages.push({ role: m.role, content: flat.text });
    }
  }

  if (messages.length === 0) {
    return err(400, "invalid_request_error",
      "`messages` must contain at least one user or assistant message after stripping system roles");
  }

  if (req.response_format?.type === "json_object") {
    const jsonInstruction = "Respond with a single valid JSON object and nothing else.";
    system = system ? `${system}\n\n${jsonInstruction}` : jsonInstruction;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens ?? req.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system) body.system = system;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.top_p != null) body.top_p = req.top_p;

  const stopSeqs = normalizeStop(req.stop);
  if (stopSeqs && stopSeqs.length > 0) body.stop_sequences = stopSeqs;

  if (req.stream) body.stream = true;
  return { ok: true, body };
}

function normalizeStop(s: OpenAIChatRequest["stop"]): string[] | null {
  if (s == null) return null;
  const arr = Array.isArray(s) ? s : [s];
  const filtered = arr.filter(x => typeof x === "string" && x.length > 0);
  return filtered.length > 0 ? filtered : null;
}

export function anthropicToOpenai(resp: AnthropicMessageResponse, nowSec: number): Record<string, unknown> {
  const text = Array.isArray(resp.content)
    ? resp.content.filter(b => b?.type === "text").map(b => b.text ?? "").join("")
    : "";
  const id = String(resp.id ?? "").replace(/^msg_/, "chatcmpl-")
    || `chatcmpl-${nowSec}`;
  const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };
  return {
    id,
    object: "chat.completion",
    created: nowSec,
    model: resp.model ?? "unknown",
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: mapStopReason(resp.stop_reason ?? null),
    }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

// Mid-stream tool_use stop_reason is impossible to surface as an OpenAI
// tool_calls payload without forwarding tool blocks (which v1 doesn't), so
// degrade to "stop" rather than mislead clients.
export function mapStopReason(r: string | null): string {
  switch (r) {
    case "end_turn": return "stop";
    case "stop_sequence": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "stop";
    default: return "stop";
  }
}

// Map Anthropic error envelopes (`{type:"error", error:{type, message}}`) to
// the OpenAI shape (`{error:{message, type, code, param}}`) so SDK error
// classes (RateLimitError, AuthenticationError, BadRequestError, …) dispatch
// correctly.
export function anthropicErrorToOpenai(status: number, anthropicBody: unknown): Record<string, unknown> {
  const env = (anthropicBody as { error?: { type?: string; message?: string } } | null)?.error;
  const aType = typeof env?.type === "string" ? env.type : null;
  const message = typeof env?.message === "string" && env.message.length > 0
    ? env.message
    : `upstream returned status ${status}`;
  const { type, code } = mapAnthropicErrorType(aType, status);
  return { error: { message, type, code, param: null } };
}

function mapAnthropicErrorType(aType: string | null, status: number): { type: string; code: string } {
  if (aType === "authentication_error" || status === 401) return { type: "invalid_request_error", code: "invalid_api_key" };
  if (aType === "permission_error" || status === 403) return { type: "invalid_request_error", code: "permission_denied" };
  if (aType === "not_found_error" || status === 404) return { type: "invalid_request_error", code: "model_not_found" };
  if (aType === "rate_limit_error" || status === 429) return { type: "rate_limit_error", code: "rate_limit_exceeded" };
  if (aType === "invalid_request_error" || status === 400) return { type: "invalid_request_error", code: "invalid_request" };
  if (aType === "overloaded_error" || status === 529) return { type: "server_error", code: "overloaded" };
  if (status >= 500) return { type: "server_error", code: "upstream_server_error" };
  return { type: "api_error", code: aType ?? "unknown" };
}

type FlattenResult = { ok: true; text: string } | { ok: false; error: string };

function flattenContent(c: OpenAIChatMessage["content"]): FlattenResult {
  if (c == null) return { ok: true, text: "" };
  if (typeof c === "string") return { ok: true, text: c };
  if (!Array.isArray(c)) return { ok: false, error: "content must be a string or array" };
  const parts: string[] = [];
  for (const part of c) {
    if (!part || typeof part !== "object") return { ok: false, error: "content part must be an object" };
    if (part.type === "text") {
      parts.push(part.text ?? "");
    } else {
      return { ok: false, error: `content part of type \`${part.type}\` is not supported by this proxy (text-only)` };
    }
  }
  return { ok: true, text: parts.join("") };
}

function err(status: number, type: string, message: string): TranslationResult {
  return { ok: false, error: { status, type, message } };
}

// Convert an Anthropic SSE stream (ReadableStream<Uint8Array>) into an
// OpenAI chat-completions SSE stream. Both are `text/event-stream` framed
// with `data: ...\n\n`. We parse Anthropic event types and emit one or more
// OpenAI delta events per Anthropic event.
//
// Emits a synthetic final chunk + `data: [DONE]\n\n` even when the upstream
// closes without `message_stop`, and translates upstream `event: error`
// frames so OpenAI clients don't hang on truncation.
export function anthropicSseToOpenaiSse(
  upstream: ReadableStream<Uint8Array>,
  modelHint: string,
  nowSec: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();

  let buffer = "";
  let id = `chatcmpl-${nowSec}`;
  let model = modelHint;
  let finishReason: string | null = null;
  let sentRole = false;
  let sentStop = false;
  let upstreamDone = false;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const emitStop = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
    if (sentStop) return;
    if (!sentRole) {
      emit(controller, {
        id, object: "chat.completion.chunk", created: nowSec, model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
      sentRole = true;
    }
    emit(controller, {
      id, object: "chat.completion.chunk", created: nowSec, model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    });
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    sentStop = true;
  };

  const drainBuffer = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    let emitted = false;
    let sepIdx: number;
    while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const parsed = parseSseEvent(rawEvent);
      if (!parsed) continue;
      const ev = parsed.event ?? parsed.data?.type ?? "";
      const data = parsed.data;

      if (ev === "message_start" && data?.message) {
        const upstreamId = data.message.id;
        if (typeof upstreamId === "string" && upstreamId.length > 0) {
          id = upstreamId.replace(/^msg_/, "chatcmpl-");
        }
        if (typeof data.message.model === "string") model = data.message.model;
        if (!sentRole) {
          emit(controller, {
            id, object: "chat.completion.chunk", created: nowSec, model,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          });
          sentRole = true;
          emitted = true;
        }
      } else if (ev === "content_block_delta" && data?.delta?.type === "text_delta") {
        emit(controller, {
          id, object: "chat.completion.chunk", created: nowSec, model,
          choices: [{ index: 0, delta: { content: String(data.delta.text ?? "") }, finish_reason: null }],
        });
        emitted = true;
      } else if (ev === "message_delta" && data?.delta?.stop_reason) {
        finishReason = mapStopReason(String(data.delta.stop_reason));
      } else if (ev === "message_stop") {
        emitStop(controller, finishReason ?? "stop");
        emitted = true;
      } else if (ev === "error") {
        // Anthropic mid-stream error frame. Translate to OpenAI error event and
        // close cleanly. We still emit [DONE] afterwards so clients don't hang.
        const errPayload = anthropicErrorToOpenai(0, data ?? { error: { type: "api_error", message: "upstream error" } });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
        emitStop(controller, "stop");
        emitted = true;
      }
    }
    return emitted;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (drainBuffer(controller)) return;
        if (upstreamDone) {
          // Stream ended (clean close or earlier abort). Flush any pending
          // multi-byte chars, drain whatever's left, then guarantee finish.
          const tail = decoder.decode();
          if (tail) { buffer += tail; if (drainBuffer(controller)) return; }
          emitStop(controller, finishReason ?? "stop");
          controller.close();
          return;
        }
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          // Upstream socket error mid-stream: surface a translated error chunk,
          // emit a finish, then close. Clients see a graceful end with a
          // structured error rather than a raw connection drop.
          const errPayload = anthropicErrorToOpenai(502, { error: { type: "api_error", message: (e as Error).message } });
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
          emitStop(controller, "stop");
          controller.close();
          return;
        }
        if (chunk.done) { upstreamDone = true; continue; }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
}

interface ParsedSse { event?: string; data?: Record<string, any>; }

function parseSseEvent(raw: string): ParsedSse | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return event ? { event } : null;
  try { return { event, data: JSON.parse(dataLines.join("\n")) }; }
  catch { return event ? { event } : null; }
}

export function modelsList(nowSec: number): Record<string, unknown> {
  // Hardcoded because Anthropic's models.list endpoint is x-api-key only and
  // not reachable via the OAuth scope (`user:inference, user:profile`) the
  // agent presents. Do NOT replace with an upstream call without first
  // confirming OAuth scope coverage.
  const ids = [
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ];
  return {
    object: "list",
    data: ids.map(id => ({ id, object: "model", created: nowSec, owned_by: "anthropic" })),
  };
}
