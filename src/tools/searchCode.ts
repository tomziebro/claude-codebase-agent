import { promises as fs } from "node:fs";
import { looksBinary } from "./workspace.js";
import { ToolInputError, type Tool, optionalBool, optionalInt, optionalString, requiredString } from "./types.js";

const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_LENGTH = 300;

interface SearchCodeInput {
  pattern: RegExp;
  path: string;
  glob?: RegExp;
  maxResults: number;
}

export const searchCode: Tool<SearchCodeInput> = {
  definition: {
    name: "search_code",
    description:
      "Search file contents with a regular expression (JavaScript syntax) and return matching " +
      "lines as path:line: text. Use this to find definitions, call sites and config values " +
      "before reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: 'Directory to search in. Defaults to ".".' },
        glob: {
          type: "string",
          description: 'Only search files whose path matches this glob, e.g. "*.ts" or "src/**/*.py".',
        },
        case_sensitive: { type: "boolean", description: "Defaults to false." },
        max_results: { type: "integer", description: "Maximum matches to return (1-500). Defaults to 100." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },

  parse(input) {
    const source = requiredString(input, "pattern");
    const flags = optionalBool(input, "case_sensitive") ? "" : "i";
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, flags);
    } catch (error) {
      throw new ToolInputError(`Invalid regular expression: ${(error as Error).message}`);
    }
    const glob = optionalString(input, "glob");
    return {
      pattern,
      path: optionalString(input, "path") ?? ".",
      glob: glob ? globToRegExp(glob) : undefined,
      maxResults: optionalInt(input, "max_results", { min: 1, max: 500 }) ?? 100,
    };
  },

  async run({ pattern, path, glob, maxResults }, workspace) {
    const root = await workspace.resolve(path);
    const stat = await fs.stat(root);
    const files = stat.isDirectory() ? workspace.walk(root) : single(root);

    const matches: string[] = [];
    let filesWithMatches = 0;

    outer: for await (const file of files) {
      const rel = workspace.relative(file);
      if (glob && !glob.test(rel)) continue;
      if ((await fs.stat(file)).size > MAX_FILE_BYTES) continue;

      const buffer = await fs.readFile(file);
      if (looksBinary(buffer)) continue;

      let matched = false;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!pattern.test(line)) continue;
        matched = true;
        matches.push(`${rel}:${i + 1}: ${truncate(line.trim())}`);
        if (matches.length >= maxResults) {
          filesWithMatches++;
          matches.push(`\n[Stopped at ${maxResults} matches. Narrow the pattern, path or glob.]`);
          break outer;
        }
      }
      if (matched) filesWithMatches++;
    }

    if (matches.length === 0) return `No matches for /${pattern.source}/ under ${path}.`;
    return `${filesWithMatches} file(s) matched:\n${matches.join("\n")}`;
  },
};

async function* single(file: string): AsyncGenerator<string> {
  yield file;
}

function truncate(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

/**
 * Converts a simple glob into a RegExp tested against a relative path.
 * Supports `*`, `**`, `?` and `{a,b}`. A pattern without a slash matches
 * against the file name in any directory, the way `.gitignore` does.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        out += `(?:${glob.slice(i + 1, close).split(",").map(escape).join("|")})`;
        i = close;
      }
    } else {
      out += escape(c);
    }
  }
  const anchored = glob.includes("/") ? `^${out}$` : `(?:^|/)${out}$`;
  return new RegExp(anchored);
}

function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
