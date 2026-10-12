import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSse, type SseEvent } from "../src/anthropic/sse.js";
import { chunks } from "./helpers.js";

async function collect(parts: string[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of parseSse(chunks(parts))) out.push(event);
  return out;
}

describe("parseSse", () => {
  it("parses named events", async () => {
    const events = await collect(['event: ping\ndata: {"type":"ping"}\n\n']);
    assert.deepEqual(events, [{ event: "ping", data: '{"type":"ping"}' }]);
  });

  it("reassembles events split across chunks, even mid-line", async () => {
    const events = await collect(["event: a\nda", "ta: 1\n", "\nevent: b\ndata: 2\n\n"]);
    assert.deepEqual(events, [
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("handles CRLF line endings", async () => {
    const events = await collect(["event: a\r\ndata: x\r\n\r\n"]);
    assert.deepEqual(events, [{ event: "a", data: "x" }]);
  });

  it("joins multi-line data and skips comments", async () => {
    const events = await collect([": keep-alive\n\ndata: line1\ndata: line2\n\n"]);
    assert.deepEqual(events, [{ event: "message", data: "line1\nline2" }]);
  });

  it("flushes a final event with no trailing blank line", async () => {
    const events = await collect(["data: last"]);
    assert.deepEqual(events, [{ event: "message", data: "last" }]);
  });

  it("decodes multi-byte UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: héllo ✓\n\n");
    async function* split() {
      yield bytes.subarray(0, 8);
      yield bytes.subarray(8);
    }
    const out: SseEvent[] = [];
    for await (const event of parseSse(split())) out.push(event);
    assert.deepEqual(out, [{ event: "message", data: "héllo ✓" }]);
  });
});
