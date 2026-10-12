import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";
import type { ToolUseBlock } from "../src/anthropic/types.js";
import { ToolRegistry } from "../src/tools/index.js";
import { globToRegExp } from "../src/tools/searchCode.js";
import { Workspace } from "../src/tools/workspace.js";
import { fixture } from "./helpers.js";

let workspace: Workspace;
let outside: string;
const registry = new ToolRegistry();

async function call(name: string, input: Record<string, unknown>) {
  const block: ToolUseBlock = { type: "tool_use", id: `tu_${name}`, name, input };
  return registry.execute(block, workspace);
}

before(async () => {
  const root = await fixture({
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo"}\n',
    "src/auth/login.ts": "export function login(user: string) {\n  return verifyToken(user);\n}\n",
    "src/auth/token.ts": "export function verifyToken(t: string) {\n  return t.length > 0;\n}\n",
    "src/server.ts": Array.from({ length: 600 }, (_, i) => `// line ${i + 1}`).join("\n"),
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    "node_modules/dep/index.js": "verifyToken();\n",
    ".git/config": "[core]\n",
  });
  outside = await fixture({ "secret.txt": "top secret\n" });
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
  workspace = await Workspace.open(root);
});

describe("list_files", () => {
  it("lists files recursively and skips ignored folders and symlinks", async () => {
    const result = await call("list_files", {});
    assert.equal(result.is_error, undefined);
    assert.deepEqual(result.content.split("\n"), [
      "assets/logo.png",
      "package.json",
      "README.md",
      "src/auth/login.ts",
      "src/auth/token.ts",
      "src/server.ts",
    ]);
  });

  it("respects depth", async () => {
    const result = await call("list_files", { path: "src", depth: 1 });
    assert.equal(result.content, "src/server.ts");
  });
});

describe("read_file", () => {
  it("returns numbered lines", async () => {
    const result = await call("read_file", { path: "src/auth/login.ts" });
    assert.match(result.content, /^src\/auth\/login\.ts \(lines 1-3 of 3\)/);
    assert.match(result.content, /2 \|   return verifyToken\(user\);/);
  });

  it("pages long files and reads ranges", async () => {
    const first = await call("read_file", { path: "src/server.ts" });
    assert.match(first.content, /lines 1-400 of 600/);
    assert.match(first.content, /Pass start_line=401/);

    const range = await call("read_file", { path: "src/server.ts", start_line: 598, end_line: 900 });
    assert.match(range.content, /lines 598-600 of 600/);
    assert.match(range.content, /600 \| \/\/ line 600$/);
  });

  it("refuses binary files", async () => {
    const result = await call("read_file", { path: "assets/logo.png" });
    assert.match(result.content, /binary/);
  });

  it("returns validation errors to the model instead of throwing", async () => {
    const result = await call("read_file", { start_line: "one" });
    assert.equal(result.is_error, true);
    assert.match(result.content, /"path" is required/);
  });
});

describe("workspace sandbox", () => {
  for (const attempt of ["../secret.txt", "/etc/passwd", "src/../../x"]) {
    it(`blocks path traversal: ${attempt}`, async () => {
      const result = await call("read_file", { path: attempt });
      assert.equal(result.is_error, true);
      assert.match(result.content, /outside the workspace|No such file/);
    });
  }

  it("blocks symlinks that point outside the root", async () => {
    const result = await call("read_file", { path: "leak.txt" });
    assert.equal(result.is_error, true);
    assert.match(result.content, /resolves outside the workspace/);
    assert.doesNotMatch(result.content, /top secret/);
  });

  it("blocks ignored directories", async () => {
    const result = await call("read_file", { path: ".git/config" });
    assert.equal(result.is_error, true);
    assert.match(result.content, /excluded/);
  });
});

describe("search_code", () => {
  it("finds matches with path:line and skips ignored folders", async () => {
    const result = await call("search_code", { pattern: "verifyToken" });
    assert.match(result.content, /^2 file\(s\) matched/);
    assert.match(result.content, /src\/auth\/login\.ts:2: return verifyToken\(user\);/);
    assert.match(result.content, /src\/auth\/token\.ts:1:/);
    assert.doesNotMatch(result.content, /node_modules/);
  });

  it("filters by glob and is case-insensitive by default", async () => {
    const result = await call("search_code", { pattern: "VERIFYTOKEN", glob: "token.ts" });
    assert.match(result.content, /^1 file\(s\) matched/);
  });

  it("caps results", async () => {
    const result = await call("search_code", { pattern: "line", path: "src", max_results: 3 });
    assert.match(result.content, /Stopped at 3 matches/);
  });

  it("reports invalid regular expressions", async () => {
    const result = await call("search_code", { pattern: "(" });
    assert.equal(result.is_error, true);
    assert.match(result.content, /Invalid regular expression/);
  });
});

describe("globToRegExp", () => {
  const cases: [string, string, boolean][] = [
    ["*.ts", "src/a/b.ts", true],
    ["*.ts", "src/a/b.tsx", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["*.{ts,tsx}", "x/y.tsx", true],
    ["?.md", "a.md", true],
    ["?.md", "ab.md", false],
  ];
  for (const [glob, file, expected] of cases) {
    it(`${glob} ${expected ? "matches" : "does not match"} ${file}`, () => {
      assert.equal(globToRegExp(glob).test(file), expected);
    });
  }
});

describe("registry", () => {
  it("reports unknown tools as errors", async () => {
    const result = await call("delete_everything", {});
    assert.equal(result.is_error, true);
    assert.match(result.content, /Unknown tool/);
  });
});
