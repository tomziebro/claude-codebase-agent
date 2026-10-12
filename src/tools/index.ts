import type { ToolDefinition, ToolResultBlock, ToolUseBlock } from "../anthropic/types.js";
import { listFiles } from "./listFiles.js";
import { readFile } from "./readFile.js";
import { searchCode } from "./searchCode.js";
import { ToolInputError, type Tool } from "./types.js";
import { WorkspaceError, type Workspace } from "./workspace.js";

const MAX_RESULT_CHARS = 40_000;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any>>();

  constructor(tools: Tool<any>[] = [listFiles, readFile, searchCode]) {
    for (const tool of tools) this.tools.set(tool.definition.name, tool);
  }

  get definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  /**
   * Runs one tool call and always returns a tool_result. Expected failures
   * (bad input, missing files) go back to the model as is_error results so it
   * can correct itself; anything unexpected is still reported, not thrown.
   */
  async execute(call: ToolUseBlock, workspace: Workspace): Promise<ToolResultBlock> {
    const tool = this.tools.get(call.name);
    if (!tool) return errorResult(call, `Unknown tool: ${call.name}`);

    try {
      const output = await tool.run(tool.parse(call.input), workspace);
      return { type: "tool_result", tool_use_id: call.id, content: clip(output) };
    } catch (error) {
      if (error instanceof ToolInputError || error instanceof WorkspaceError) {
        return errorResult(call, error.message);
      }
      return errorResult(call, `Tool failed: ${(error as Error).message ?? String(error)}`);
    }
  }
}

function errorResult(call: ToolUseBlock, message: string): ToolResultBlock {
  return { type: "tool_result", tool_use_id: call.id, content: message, is_error: true };
}

function clip(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Output truncated at ${MAX_RESULT_CHARS} characters.]`;
}
