import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "__pycache__",
  ".DS_Store",
];

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * A read-only view of one directory tree. Every path the model supplies is
 * resolved through here, so nothing outside the root can be read, including
 * via `..` segments, absolute paths or symlinks that point elsewhere.
 */
export class Workspace {
  private constructor(
    readonly root: string,
    private readonly ignores: Set<string>,
  ) {}

  static async open(root: string, ignores: string[] = DEFAULT_IGNORES): Promise<Workspace> {
    const resolved = await fs.realpath(path.resolve(root)).catch(() => {
      throw new WorkspaceError(`Directory not found: ${root}`);
    });
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new WorkspaceError(`Not a directory: ${root}`);
    return new Workspace(resolved, new Set(ignores));
  }

  /** Resolves a model-supplied relative path to a real path inside the root. */
  async resolve(relativePath = "."): Promise<string> {
    const candidate = path.resolve(this.root, relativePath);
    if (!this.contains(candidate)) {
      throw new WorkspaceError(`Path is outside the workspace: ${relativePath}`);
    }

    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new WorkspaceError(`No such file or directory: ${relativePath}`);
    }
    if (!this.contains(real)) {
      throw new WorkspaceError(`Path resolves outside the workspace: ${relativePath}`);
    }
    if (this.isIgnored(real)) {
      throw new WorkspaceError(`Path is excluded from the workspace: ${relativePath}`);
    }
    return real;
  }

  relative(absolutePath: string): string {
    const rel = path.relative(this.root, absolutePath);
    return (rel || ".").split(path.sep).join("/");
  }

  isIgnoredName(name: string): boolean {
    return this.ignores.has(name);
  }

  /** Walks files under `dir` in sorted order, skipping ignored names and symlinks. */
  async *walk(dir: string, maxDepth = Infinity, depth = 0): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (this.isIgnoredName(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) yield* this.walk(full, maxDepth, depth + 1);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }

  private contains(absolutePath: string): boolean {
    const rel = path.relative(this.root, absolutePath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  private isIgnored(absolutePath: string): boolean {
    return this.relative(absolutePath)
      .split("/")
      .some((segment) => this.ignores.has(segment));
  }
}

/** Heuristic binary check: a NUL byte in the first 8 KB. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}
