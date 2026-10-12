import { promises as fs } from "node:fs";
import { looksBinary } from "./workspace.js";
import { type Tool, optionalInt, requiredString } from "./types.js";

const MAX_BYTES = 1_000_000;
const DEFAULT_LINES = 400;

interface ReadFileInput {
  path: string;
  startLine: number;
  endLine?: number;
}

export const readFile: Tool<ReadFileInput> = {
  definition: {
    name: "read_file",
    description:
      "Read a text file from the codebase. Output is prefixed with line numbers. Large files " +
      `return the first ${DEFAULT_LINES} lines by default; pass start_line and end_line to ` +
      "read a specific range, ideally around matches found with search_code.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repository root." },
        start_line: { type: "integer", description: "First line to read (1-based). Defaults to 1." },
        end_line: { type: "integer", description: "Last line to read, inclusive." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },

  parse(input) {
    const limits = { min: 1, max: 10_000_000 };
    return {
      path: requiredString(input, "path"),
      startLine: optionalInt(input, "start_line", limits) ?? 1,
      endLine: optionalInt(input, "end_line", limits),
    };
  },

  async run({ path, startLine, endLine }, workspace) {
    const file = await workspace.resolve(path);
    const stat = await fs.stat(file);
    if (stat.isDirectory()) return `${path} is a directory. Use list_files instead.`;
    if (stat.size > MAX_BYTES) {
      return `${path} is ${stat.size} bytes, too large to read. Use search_code to find the relevant part.`;
    }

    const buffer = await fs.readFile(file);
    if (looksBinary(buffer)) return `${path} appears to be a binary file.`;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const total = lines.length;
    if (startLine > total) return `${path} has only ${total} lines.`;

    const last = Math.min(endLine ?? startLine + DEFAULT_LINES - 1, total);
    if (last < startLine) return "end_line must be greater than or equal to start_line.";

    const width = String(last).length;
    const body = lines
      .slice(startLine - 1, last)
      .map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`)
      .join("\n");

    const header = `${path} (lines ${startLine}-${last} of ${total})`;
    const more = last < total ? `\n\n[${total - last} more lines. Pass start_line=${last + 1} to continue.]` : "";
    return `${header}\n${body}${more}`;
  },
};
