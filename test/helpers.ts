import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MessagesClient } from "../src/anthropic/client.js";
import type { ContentBlock, Message, MessageRequest, StopReason } from "../src/anthropic/types.js";

/** Creates a temp directory populated with the given files. */
export async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-agent-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

export function message(content: ContentBlock[], stopReason: StopReason, usage = { input: 100, output: 20 }): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason: stopReason,
    usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: 50 },
  };
}

/** A MessagesClient that replays scripted responses and records every request. */
export class ScriptedClient implements MessagesClient {
  readonly requests: MessageRequest[] = [];

  constructor(private readonly responses: Message[]) {}

  async stream(request: MessageRequest, handlers: { onText?: (t: string) => void } = {}): Promise<Message> {
    // Deep-copy so later mutation of history can't rewrite what we recorded.
    this.requests.push(structuredClone(request));
    const next = this.responses.shift();
    if (!next) throw new Error("ScriptedClient ran out of responses");
    for (const block of next.content) if (block.type === "text") handlers.onText?.(block.text);
    return next;
  }
}

export function bytes(text: string): AsyncIterable<Uint8Array> {
  return chunks([text]);
}

export async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

export function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}
