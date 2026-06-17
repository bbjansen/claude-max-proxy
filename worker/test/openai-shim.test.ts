import { describe, it, expect } from "vitest";
import {
  openaiToAnthropic,
  anthropicToOpenai,
  mapStopReason,
  anthropicSseToOpenaiSse,
  modelsList,
} from "../src/openai-shim.js";

describe("openaiToAnthropic", () => {
  it("collapses system messages and excludes them from messages array", () => {
    const out = openaiToAnthropic({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "You are X." },
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out.system).toBe("You are X.\n\nBe terse.");
    expect(out.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("preserves user/assistant order and defaults max_tokens", () => {
    const out = openaiToAnthropic({
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
    expect(out.max_tokens).toBe(4096);
  });

  it("maps temperature, top_p, stop, stream", () => {
    const out = openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }],
      temperature: 0.2, top_p: 0.9, stop: ["END"], stream: true,
    });
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.stream).toBe(true);
  });

  it("appends a JSON instruction when response_format=json_object", () => {
    const out = openaiToAnthropic({
      model: "m", messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_object" },
    });
    expect(out.system).toMatch(/single valid JSON object/);
  });

  it("flattens content arrays of text parts", () => {
    const out = openaiToAnthropic({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] as any }],
    }) as any;
    expect(out.messages[0].content).toBe("ab");
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
});

describe("mapStopReason", () => {
  it("translates known reasons", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason(null)).toBe("stop");
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

  it("translates the full message_start→delta→stop sequence", async () => {
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(frame("message_start", { type: "message_start", message: { id: "msg_xyz", model: "claude-haiku-4-5" } })));
        c.enqueue(enc.encode(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
        c.enqueue(enc.encode(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } })));
        c.enqueue(enc.encode(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } })));
        c.enqueue(enc.encode(frame("content_block_stop", { type: "content_block_stop", index: 0 })));
        c.enqueue(enc.encode(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })));
        c.enqueue(enc.encode(frame("message_stop", { type: "message_stop" })));
        c.close();
      },
    });
    const out = await collect(anthropicSseToOpenaiSse(src, "claude-haiku-4-5", 1700000000));
    expect(out).toContain('"role":"assistant"');
    expect(out).toContain('"content":"hel"');
    expect(out).toContain('"content":"lo"');
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
