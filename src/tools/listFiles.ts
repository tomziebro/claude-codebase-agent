import { promises as fs } from "node:fs";
import { type Tool, optionalInt, optionalString } from "./types.js";

const MAX_ENTRIES = 500;

interface ListFilesInput {
  path: string;
  depth: number;
}

export const listFiles: Tool<ListFilesInput> = {
  definition: {
    name: "list_files",
    description:
      "List files under a directory in the codebase, recursively, as paths relative to the " +
      "repository root. Common build output and dependency folders are excluded. Use this " +
      "first to get oriented, then narrow down with a subdirectory path.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'Directory to list, relative to the repository root. Defaults to ".".',
        },
        depth: {
          type: "integer",
          description: "How many directory levels to descend (1-10). Defaults to 4.",
        },
      },
      additionalProperties: false,
    },
  },

  parse(input) {
    return {
      path: optionalString(input, "path") ?? ".",
      depth: optionalInt(input, "depth", { min: 1, max: 10 }) ?? 4,
    };
  },

  async run({ path, depth }, workspace) {
    const dir = await workspace.resolve(path);
    if (!(await fs.stat(dir)).isDirectory()) return `${path} is a file, not a directory.`;

    const files: string[] = [];
    let truncated = false;
    for await (const file of workspace.walk(dir, depth - 1)) {
      if (files.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      files.push(workspace.relative(file));
    }

    if (files.length === 0) return `No files found under ${path}.`;
    const note = truncated
      ? `\n\n[Showing the first ${MAX_ENTRIES} files. List a subdirectory for more.]`
      : "";
    return files.join("\n") + note;
  },
};
