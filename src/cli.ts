#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { stderr, stdin, stdout } from "node:process";
import { CodebaseAgent, type AgentResult } from "./agent.js";
import { ApiError, HttpMessagesClient } from "./anthropic/client.js";
import { Workspace, WorkspaceError } from "./tools/workspace.js";

const DEFAULT_MODEL = "claude-sonnet-5-5";

const HELP = `Ask questions about a codebase. Claude explores it with read-only tools.

Usage:
  codebase-agent [options] [question]

With a question, prints one answer and exits. Without one, starts an
interactive session where follow-up questions keep their context.

Options:
  -r, --root <dir>       Repository to explore (default: current directory)
  -m, --model <id>       Claude model (default: $CLAUDE_MODEL or ${DEFAULT_MODEL})
      --max-turns <n>    Tool-use round trips per question (default: 25)
  -q, --quiet            Hide tool calls and the usage summary
  -h, --help             Show this help

Environment:
  ANTHROPIC_API_KEY      Required
  ANTHROPIC_BASE_URL     Optional API base URL override

Examples:
  codebase-agent "Where is authentication handled?"
  codebase-agent -r ../my-service "How does a request reach the database?"`;

const color = (code: number) => (text: string) =>
  stderr.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
const dim = color(2);
const cyan = color(36);
const red = color(31);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", short: "r", default: "." },
      model: { type: "string", short: "m" },
      "max-turns": { type: "string", default: "25" },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    stdout.write(`${HELP}\n`);
    return 0;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    stderr.write(red("ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com\n"));
    return 1;
  }

  const maxTurns = Number(values["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    stderr.write(red("--max-turns must be a positive integer.\n"));
    return 1;
  }

  const workspace = await Workspace.open(values.root);
  const quiet = values.quiet;
  const agent = new CodebaseAgent({
    client: new HttpMessagesClient({ apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL }),
    workspace,
    model: values.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    maxTurns,
    events: {
      onText: (text) => stdout.write(text),
      onToolCall: (call) => {
        if (!quiet) stderr.write(`\n${cyan("›")} ${dim(`${call.name} ${JSON.stringify(call.input)}`)}\n`);
      },
      onToolResult: (_call, output, isError) => {
        if (!quiet && isError) stderr.write(`  ${red(output)}\n`);
      },
    },
  });

  const question = positionals.join(" ").trim();
  if (question) {
    report(await agent.ask(question), quiet);
    return 0;
  }

  return repl(agent, workspace.root, quiet);
}

async function repl(agent: CodebaseAgent, root: string, quiet: boolean): Promise<number> {
  stderr.write(dim(`Exploring ${root}\nAsk a question. /reset clears context, /exit quits.\n`));
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const line = (await rl.question("\n> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/reset") {
        agent.reset();
        stderr.write(dim("Context cleared.\n"));
        continue;
      }
      try {
        report(await agent.ask(line), quiet);
      } catch (error) {
        stderr.write(red(`\n${describe(error)}\n`));
      }
    }
  } catch (error) {
    // Ctrl-D closes stdin; treat it as a normal exit.
    if ((error as NodeJS.ErrnoException).code !== "ABORT_ERR") throw error;
  } finally {
    rl.close();
  }
  return 0;
}

function report(result: AgentResult, quiet: boolean): void {
  stdout.write("\n");
  if (result.stopReason === "max_turns") {
    stderr.write(red("Hit the turn limit before finishing. Try --max-turns or a narrower question.\n"));
  }
  if (quiet) return;
  const { inputTokens, outputTokens, cacheReadTokens } = result.usage;
  stderr.write(
    dim(
      `\n${result.turns} turn(s) · ${result.toolCalls} tool call(s) · ` +
        `${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out · ` +
        `${cacheReadTokens.toLocaleString()} cached\n`,
    ),
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError || error instanceof WorkspaceError) return error.message;
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    stderr.write(red(`${describe(error)}\n`));
    process.exit(1);
  },
);
