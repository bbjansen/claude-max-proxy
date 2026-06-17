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

export function openaiToAnthropic(req: OpenAIChatRequest): Record<string, unknown> {
  let system: string | undefined;
  const messages: Array<{ role: string; content: string }> = [];

  for (const m of req.messages) {
    const text = flattenContent(m.content);
    if (m.role === "system") {
      system = system ? `${system}\n\n${text}` : text;
    } else if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: text });
    }
    // tool/function roles are intentionally skipped in v1.
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
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.stream) body.stream = true;
  return body;
}

export function anthropicToOpenai(resp: AnthropicMessageResponse, nowSec: number): Record<string, unknown> {
  const text = resp.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  return {
    id: resp.id.replace(/^msg_/, "chatcmpl-"),
    object: "chat.completion",
    created: nowSec,
    model: resp.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: mapStopReason(resp.stop_reason),
    }],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
    },
  };
}

export function mapStopReason(r: string | null): string {
  switch (r) {
    case "end_turn": return "stop";
    case "stop_sequence": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    default: return "stop";
  }
}

function flattenContent(c: OpenAIChatMessage["content"]): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  return c.map(part => part.type === "text" ? (part.text ?? "") : "").join("");
}

// Convert an Anthropic SSE stream (ReadableStream<Uint8Array>) into an
// OpenAI chat-completions SSE stream. Both are `text/event-stream` framed
// with `data: ...\n\n`. We parse Anthropic event types and emit one or more
// OpenAI delta events per Anthropic event.
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
  let done = false;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
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
        id = String(data.message.id ?? id).replace(/^msg_/, "chatcmpl-");
        model = String(data.message.model ?? model);
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
        emit(controller, {
          id, object: "chat.completion.chunk", created: nowSec, model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }],
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        emitted = true;
      }
    }
    return emitted;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (drainBuffer(controller)) return;
        if (done) { controller.close(); return; }
        const { value, done: streamDone } = await reader.read();
        if (streamDone) { done = true; continue; }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
}

interface ParsedSse { event?: string; data?: Record<string, any>; }

function parseSseEvent(raw: string): ParsedSse | null {
  let event: string | undefined;
  let dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return event ? { event } : null;
  try { return { event, data: JSON.parse(dataLines.join("\n")) }; }
  catch { return event ? { event } : null; }
}

export function modelsList(nowSec: number): Record<string, unknown> {
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
