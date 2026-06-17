import { describe, it, expect } from "vitest";
import {
  openaiToAnthropic,
  anthropicToOpenai,
  anthropicErrorToOpenai,
  mapStopReason,
  anthropicSseToOpenaiSse,
  modelsList,
} from "../src/openai-shim.js";

function okBody(out: ReturnType<typeof openaiToAnthropic>) {
  if (!out.ok) throw new Error(`expected ok, got error: ${JSON.stringify(out.error)}`);
  return out.body as Record<string, any>;
}

describe("openaiToAnthropic", () => {
  it("collapses system messages and excludes them from messages array", () => {
    const out = okBody(openaiToAnthropic({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "You are X." },
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
      ],
    }));
    expect(out.system).toBe("You are X.\n\nBe terse.");
    expect(out.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("preserves user/assistant order and defaults max_tokens", () => {
    const out = okBody(openaiToAnthropic({
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
      ],
    }));
    expect(out.messages).toEqual([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
    expect(out.max_tokens).toBe(4096);
  });

  it("maps temperature, top_p, stop, stream", () => {
    const out = okBody(openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }],
      temperature: 0.2, top_p: 0.9, stop: ["END"], stream: true,
    }));
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.stream).toBe(true);
  });

  it("ignores null temperature / top_p (clients commonly send null for default)", () => {
    const out = okBody(openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }],
      temperature: null as unknown as number,
      top_p: null as unknown as number,
    }));
    expect("temperature" in out).toBe(false);
    expect("top_p" in out).toBe(false);
  });

  it("drops empty stop arrays and empty-string entries instead of forwarding them", () => {
    const out1 = okBody(openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }], stop: [],
    }));
    expect("stop_sequences" in out1).toBe(false);

    const out2 = okBody(openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }], stop: ["", "END", ""],
    }));
    expect(out2.stop_sequences).toEqual(["END"]);

    const out3 = okBody(openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }], stop: "",
    }));
    expect("stop_sequences" in out3).toBe(false);
  });

  it("appends a JSON instruction when response_format=json_object", () => {
    const out = okBody(openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_object" },
    }));
    expect(out.system).toMatch(/single valid JSON object/);
  });

  it("flattens content arrays of text parts", () => {
    const out = okBody(openaiToAnthropic({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] as never }],
    }));
    expect(out.messages[0].content).toBe("ab");
  });

  it("returns a 400 invalid_request_error when content contains non-text parts (multimodal not supported)", () => {
    const out = openaiToAnthropic({
      model: "m",
      messages: [{ role: "user", content: [{ type: "image_url" } as never, { type: "text", text: "hi" }] as never }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.status).toBe(400);
      expect(out.error.type).toBe("invalid_request_error");
      expect(out.error.message).toMatch(/image_url/);
    }
  });

  it("returns a 400 when no user/assistant message survives translation", () => {
    const out = openaiToAnthropic({
      model: "m",
      messages: [{ role: "system", content: "only a system prompt" }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.status).toBe(400);
  });

  it("rejects unsupported tool/function roles explicitly rather than dropping", () => {
    const out = openaiToAnthropic({
      model: "m",
      messages: [{ role: "tool" as never, content: "x" }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toMatch(/tool/);
  });
});

describe("anthropicToOpenai", () => {
  it("maps content text and usage", () => {
    const out = anthropicToOpenai({
      id: "msg_abc", type: "message", role: "assistant", model: "claude-haiku-4-5",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    }, 1700000000) as any;
    expect(out.id).toBe("chatcmpl-abc");
    expect(out.object).toBe("chat.completion");
    expect(out.created).toBe(1700000000);
    expect(out.choices[0].message.content).toBe("hello");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("tolerates missing/non-conforming upstream fields", () => {
    const out = anthropicToOpenai({} as never, 1700000000) as any;
    expect(out.id).toBe("chatcmpl-1700000000");
    expect(out.choices[0].message.content).toBe("");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe("mapStopReason", () => {
  it("translates known reasons; tool_use degrades to stop since shim emits no tool_calls payload", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("tool_use")).toBe("stop");
    expect(mapStopReason(null)).toBe("stop");
  });
});

describe("anthropicErrorToOpenai", () => {
  it("maps rate_limit_error", () => {
    const out = anthropicErrorToOpenai(429, { type: "error", error: { type: "rate_limit_error", message: "too many" } }) as any;
    expect(out.error.message).toBe("too many");
    expect(out.error.type).toBe("rate_limit_error");
    expect(out.error.code).toBe("rate_limit_exceeded");
  });

  it("falls back to a useful message when body is missing or non-conforming", () => {
    const out = anthropicErrorToOpenai(500, null) as any;
    expect(out.error.message).toMatch(/status 500/);
    expect(out.error.type).toBe("server_error");
  });
});

describe("anthropicSseToOpenaiSse", () => {
  function frame(event: string, data: unknown) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: string[] = [];
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value));
    }
    return chunks.join("");
  }

  function srcFromFrames(frames: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    });
  }

  it("translates the full message_start→delta→stop sequence", async () => {
    const src = srcFromFrames([
      frame("message_start", { type: "message_start", message: { id: "msg_xyz", model: "claude-haiku-4-5" } }),
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      frame("message_stop", { type: "message_stop" }),
    ]);
    const out = await collect(anthropicSseToOpenaiSse(src, "claude-haiku-4-5", 1700000000));
    expect(out).toContain('"role":"assistant"');
    expect(out).toContain('"content":"hel"');
    expect(out).toContain('"content":"lo"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("synthesises a final chunk and [DONE] when upstream closes without message_stop", async () => {
    const src = srcFromFrames([
      frame("message_start", { type: "message_start", message: { id: "msg_zzz", model: "claude-haiku-4-5" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } }),
      // No message_stop frame
    ]);
    const out = await collect(anthropicSseToOpenaiSse(src, "m", 1700000000));
    expect(out).toContain('"content":"x"');
    expect(out).toContain('"finish_reason":"length"');
    expect(out.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("translates mid-stream Anthropic `event: error` into an OpenAI error chunk + finish + [DONE]", async () => {
    const src = srcFromFrames([
      frame("message_start", { type: "message_start", message: { id: "msg_a", model: "m" } }),
      frame("error", { type: "error", error: { type: "overloaded_error", message: "boom" } }),
    ]);
    const out = await collect(anthropicSseToOpenaiSse(src, "m", 1700000000));
    expect(out).toContain('"type":"server_error"');
    expect(out).toContain('"code":"overloaded"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.trim().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("modelsList", () => {
  it("returns a non-empty list of claude models in OpenAI shape", () => {
    const out = modelsList(1700000000) as any;
    expect(out.object).toBe("list");
    expect(out.data.length).toBeGreaterThan(0);
    expect(out.data[0]).toMatchObject({ object: "model", owned_by: "anthropic" });
  });
});
