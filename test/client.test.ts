import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, HttpMessagesClient, accumulateStream } from "../src/anthropic/client.js";
import type { StreamEvent } from "../src/anthropic/types.js";
import { sse } from "./helpers.js";

const start: StreamEvent = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 42, output_tokens: 1, cache_read_input_tokens: 30 },
  },
};

const toolTurn: StreamEvent[] = [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "look." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } },
  { type: "message_stop" },
];

async function* from(events: StreamEvent[]) {
  yield* events;
}

describe("accumulateStream", () => {
  it("builds the final message from text and tool_use deltas", async () => {
    const texts: string[] = [];
    const tools: string[] = [];
    const message = await accumulateStream(from(toolTurn), {
      onText: (t) => texts.push(t),
      onToolUseStart: (b) => tools.push(b.name),
    });

    assert.deepEqual(texts, ["Let me ", "look."]);
    assert.deepEqual(tools, ["read_file"]);
    assert.equal(message.stop_reason, "tool_use");
    assert.deepEqual(message.content, [
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "README.md" } },
    ]);
    // message_delta usage is cumulative and merges over message_start usage.
    assert.deepEqual(message.usage, { input_tokens: 42, output_tokens: 25, cache_read_input_tokens: 30 });
  });

  it("treats a tool call with no input deltas as an empty object", async () => {
    const message = await accumulateStream(
      from([
        start,
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "list_files", input: {} } },
        { type: "content_block_stop", index: 0 },
      ]),
    );
    assert.deepEqual(message.content[0], { type: "tool_use", id: "t", name: "list_files", input: {} });
  });

  it("throws on an error event", async () => {
    await assert.rejects(
      accumulateStream(from([start, { type: "error", error: { type: "overloaded_error", message: "busy" } }])),
      /overloaded_error/,
    );
  });
});

describe("HttpMessagesClient", () => {
  function streamResponse(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("sends a streaming request with the right headers", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = new HttpMessagesClient({
      apiKey: "sk-test",
      baseUrl: "https://example.test/",
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return streamResponse(sse(toolTurn));
      },
    });

    const message = await client.stream({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });

    assert.equal(seen?.url, "https://example.test/v1/messages");
    const headers = seen?.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(JSON.parse(String(seen?.init.body)).stream, true);
    assert.equal(message.content.length, 2);
  });

  it("retries overloaded and rate-limited responses, honoring retry-after", async () => {
    const statuses = [529, 429, 200];
    const delays: number[] = [];
    const client = new HttpMessagesClient({
      apiKey: "k",
      sleep: async (ms) => void delays.push(ms),
      fetchImpl: async () => {
        const status = statuses.shift() as number;
        if (status === 200) return streamResponse(sse(toolTurn));
        return new Response(JSON.stringify({ error: { type: "x", message: "slow down" } }), {
          status,
          headers: status === 429 ? { "retry-after": "2" } : {},
        });
      },
    });

    await client.stream({ model: "m", max_tokens: 10, messages: [] });
    assert.equal(delays.length, 2);
    assert.equal(delays[1], 2000);
  });

  it("does not retry client errors", async () => {
    let calls = 0;
    const client = new HttpMessagesClient({
      apiKey: "k",
      sleep: async () => {},
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }), { status: 400 });
      },
    });

    await assert.rejects(
      client.stream({ model: "m", max_tokens: 10, messages: [] }),
      (error: unknown) => error instanceof ApiError && error.status === 400 && error.errorType === "invalid_request_error",
    );
    assert.equal(calls, 1);
  });

  it("gives up after maxRetries", async () => {
    let calls = 0;
    const client = new HttpMessagesClient({
      apiKey: "k",
      maxRetries: 2,
      sleep: async () => {},
      fetchImpl: async () => {
        calls++;
        return new Response("oops", { status: 500 });
      },
    });
    await assert.rejects(client.stream({ model: "m", max_tokens: 10, messages: [] }), ApiError);
    assert.equal(calls, 3);
  });
});
