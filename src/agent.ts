import type { MessagesClient } from "./anthropic/client.js";
import type {
  MessageParam,
  StopReason,
  TextBlock,
  ToolDefinition,
  ToolUseBlock,
  Usage,
} from "./anthropic/types.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { ToolRegistry } from "./tools/index.js";
import type { Workspace } from "./tools/workspace.js";

export interface AgentOptions {
  client: MessagesClient;
  workspace: Workspace;
  model: string;
  maxTokens?: number;
  maxTurns?: number;
  tools?: ToolRegistry;
  events?: AgentEvents;
}

export interface AgentEvents {
  onText?: (text: string) => void;
  onToolCall?: (call: ToolUseBlock) => void;
  onToolResult?: (call: ToolUseBlock, output: string, isError: boolean) => void;
}

export interface AgentResult {
  answer: string;
  turns: number;
  toolCalls: number;
  stopReason: StopReason | "max_turns" | null;
  usage: UsageTotals;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * A tool-using agent that answers questions about one codebase. It keeps the
 * conversation across calls to `ask`, so follow-up questions have context.
 */
export class CodebaseAgent {
  private readonly history: MessageParam[] = [];
  private readonly tools: ToolRegistry;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly system: TextBlock[];

  constructor(private readonly options: AgentOptions) {
    this.tools = options.tools ?? new ToolRegistry();

    // Tool definitions and the system prompt are identical on every request, so
    // mark the end of each as a prompt-cache breakpoint.
    const definitions = this.tools.definitions;
    this.toolDefinitions = definitions.map((tool, i) =>
      i === definitions.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool,
    );
    this.system = [
      {
        type: "text",
        text: `${SYSTEM_PROMPT}\n\nRepository root: ${options.workspace.root}`,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  async ask(question: string): Promise<AgentResult> {
    const { client, workspace, model, events = {} } = this.options;
    const maxTurns = this.options.maxTurns ?? 25;
    const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const answer: string[] = [];
    let toolCalls = 0;

    this.history.push({ role: "user", content: question });

    for (let turn = 1; turn <= maxTurns; turn++) {
      const response = await client.stream(
        {
          model,
          max_tokens: this.options.maxTokens ?? 8192,
          system: this.system,
          tools: this.toolDefinitions,
          messages: withHistoryCacheBreakpoint(this.history),
        },
        { onText: events.onText },
      );

      addUsage(usage, response.usage);
      this.history.push({ role: "assistant", content: response.content });

      const text = response.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (text) answer.push(text);

      const calls = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || calls.length === 0) {
        // The final turn holds the answer; earlier text is narration between tool calls.
        return { answer: text, turns: turn, toolCalls, stopReason: response.stop_reason, usage };
      }

      // Independent reads, so run them concurrently. Results keep call order.
      const results = await Promise.all(
        calls.map(async (call) => {
          events.onToolCall?.(call);
          const result = await this.tools.execute(call, workspace);
          events.onToolResult?.(call, result.content, result.is_error === true);
          return result;
        }),
      );
      toolCalls += calls.length;
      this.history.push({ role: "user", content: results });
    }

    return {
      answer: answer.join("\n\n").trim() || "Stopped before reaching an answer (turn limit).",
      turns: maxTurns,
      toolCalls,
      stopReason: "max_turns",
      usage,
    };
  }

  /** Clears conversation history. */
  reset(): void {
    this.history.length = 0;
  }
}

function addUsage(totals: UsageTotals, usage: Usage): void {
  totals.inputTokens += usage.input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
  totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

/**
 * Returns a copy of the history with a cache breakpoint on the last block of
 * the final message, so each turn reuses the cached prefix from the last one.
 * The stored history is never mutated.
 */
export function withHistoryCacheBreakpoint(history: MessageParam[]): MessageParam[] {
  if (history.length === 0) return history;
  const last = history[history.length - 1] as MessageParam;
  const blocks =
    typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1];
  if (tail && tail.type !== "tool_use") {
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  }
  return [...history.slice(0, -1), { role: last.role, content: blocks }];
}
