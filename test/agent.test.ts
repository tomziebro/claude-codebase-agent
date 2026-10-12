import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { CodebaseAgent, withHistoryCacheBreakpoint } from "../src/agent.js";
import type { MessageParam, RequestContentBlock } from "../src/anthropic/types.js";
import { Workspace } from "../src/tools/workspace.js";
import { ScriptedClient, fixture, message } from "./helpers.js";

let workspace: Workspace;

before(async () => {
  workspace = await Workspace.open(
    await fixture({
      "src/auth.ts": "export const SESSION_TTL = 3600;\n",
      "README.md": "# App\n",
    }),
  );
});

describe("CodebaseAgent", () => {
  it("runs tools until the model answers, feeding results back in order", async () => {
    const client = new ScriptedClient([
      message(
        [
          { type: "text", text: "Searching." },
          { type: "tool_use", id: "a", name: "search_code", input: { pattern: "SESSION_TTL" } },
          { type: "tool_use", id: "b", name: "read_file", input: { path: "README.md" } },
        ],
        "tool_use",
      ),
      message([{ type: "text", text: "Sessions last 3600s (src/auth.ts:1)." }], "end_turn"),
    ]);

    const calls: string[] = [];
    const streamed: string[] = [];
    const agent = new CodebaseAgent({
      client,
      workspace,
      model: "test-model",
      events: { onToolCall: (c) => calls.push(c.name), onText: (t) => streamed.push(t) },
    });

    const result = await agent.ask("How long do sessions last?");

    assert.equal(result.answer, "Sessions last 3600s (src/auth.ts:1).");
    assert.equal(result.turns, 2);
    assert.equal(result.toolCalls, 2);
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(calls, ["search_code", "read_file"]);
    assert.deepEqual(streamed, ["Searching.", "Sessions last 3600s (src/auth.ts:1)."]);
    assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 0 });

    // The second request carries the tool results for both calls, in order.
    const second = client.requests[1];
    const toolResults = second?.messages.at(-1)?.content as RequestContentBlock[];
    assert.deepEqual(
      toolResults.map((b) => b.type === "tool_result" && b.tool_use_id),
      ["a", "b"],
    );
    assert.match(String(toolResults[0]?.type === "tool_result" && toolResults[0].content), /src\/auth\.ts:1/);
  });

  it("sends tools and a cached system prompt on every request", async () => {
    const client = new ScriptedClient([message([{ type: "text", text: "ok" }], "end_turn")]);
    await new CodebaseAgent({ client, workspace, model: "test-model" }).ask("hi");

    const request = client.requests[0];
    assert.equal(request?.model, "test-model");
    assert.deepEqual(
      request?.tools?.map((t) => t.name),
      ["list_files", "read_file", "search_code"],
    );
    assert.deepEqual(request?.tools?.at(-1)?.cache_control, { type: "ephemeral" });
    assert.ok(Array.isArray(request?.system));
    assert.match(JSON.stringify(request?.system), new RegExp(workspace.root.replace(/[/\\]/g, ".")));
  });

  it("keeps context across questions until reset", async () => {
    const client = new ScriptedClient([
      message([{ type: "text", text: "first" }], "end_turn"),
      message([{ type: "text", text: "second" }], "end_turn"),
      message([{ type: "text", text: "third" }], "end_turn"),
    ]);
    const agent = new CodebaseAgent({ client, workspace, model: "m" });

    await agent.ask("one");
    await agent.ask("two");
    assert.equal(client.requests[1]?.messages.length, 3);

    agent.reset();
    await agent.ask("three");
    assert.equal(client.requests[2]?.messages.length, 1);
  });

  it("stops at the turn limit", async () => {
    const loop = () =>
      message([{ type: "tool_use", id: crypto.randomUUID(), name: "list_files", input: {} }], "tool_use");
    const client = new ScriptedClient([loop(), loop(), loop()]);
    const result = await new CodebaseAgent({ client, workspace, model: "m", maxTurns: 3 }).ask("loop forever");

    assert.equal(result.stopReason, "max_turns");
    assert.equal(result.turns, 3);
    assert.equal(client.requests.length, 3);
  });
});

describe("withHistoryCacheBreakpoint", () => {
  it("marks the final block without mutating history", () => {
    const history: MessageParam[] = [{ role: "user", content: "question" }];
    const marked = withHistoryCacheBreakpoint(history);

    assert.deepEqual(marked[0]?.content, [{ type: "text", text: "question", cache_control: { type: "ephemeral" } }]);
    assert.equal(history[0]?.content, "question");
  });
});
