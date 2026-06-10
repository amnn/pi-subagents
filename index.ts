/** Subagents
 *
 * A lightweight Pi extension for running markdown-defined subagents as
 * isolated tasks.
 *
 * The extension discovers agent definitions from the following sub-directories
 * of the current directory or an ancestor:
 *
 * - `.pi/agents/*.md`
 * - `.agents/agents/*.md`
 *
 * Otherwise the following directories are searched for fallbacks:
 *
 * - `~/.pi/agent/agents/*.md`
 * - `~/.agent/agents/*.md`
 *
 * Project definitions override user definitions with the same command name.
 * Definitions in child directories take precedence over definitions in
 * ancestors.
 *
 * The extension registers a tool for the agent to call subagents from the main
 * agent. It also updates the system prompt to advertise the available
 * subagents to the main agent and registers a slash command for each
 * discovered agent:
 *
 *     /agent:<name> [task]
 *
 * Running an agent involves creating a child `pi` process without a session
 * and with an augmented system prompt that includes subagent instructions.
 * This subagent is given an isolated task to act on and produce a final
 * summary, which is then handed back to the main agent.
 *
 * Progress updates are shown in the main agent's UI periodically as the
 * subagent runs.
 *
 * Subagents do not have access to custom extensions, to prevent recursion
 * (subagents have a tendency to delegate their entire task if given the
 * opportunity).
 *
 * Agent files are markdown with optional YAML-like frontmatter:
 *
 *     ---
 *     name: reviewer
 *     description: Review the current work
 *     ---
 *
 *     Review the current work and report findings.
 *
 * The format is generic so other harnesses can consume the same definitions.
 */

import { ChildProcessByStdio, spawn } from "node:child_process";
import { Dirent, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import { Type } from "typebox";

import { Text } from "@mariozechner/pi-tui";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type {
  AgentEvent,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentMessage,
} from "@mariozechner/pi-agent-core";

interface Agent {
  name: string;
  description: string;
  prompt: string;
  file: string;
}

type Update =
  | {
      type: "partial";
      agent: string;
      turns: number;
      update: string;
    }
  | {
      type: "result";
      agent: string;
      task: string | undefined;
      turns: number;
      output: string;
      stderr: string;
      exit: number;
      aborted: boolean;
    };

/** Agents discovered on session start */
const discovery: Map<string, Agent> = new Map();

const ToolParams = Type.Object({
  agent: Type.String({ description: "The name of the agent to run" }),
  task: Type.Optional(Type.String({ description: "Task to delegate" })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",

    description: [
      "Run an agent turn in the current context with additional instructions. Its tree is",
      "summarized and wiped on turn end, but filesystem changes persist.",
    ].join(" "),

    promptSnippet:
      "Run an agent in the current context with custom additional instructions for a single turn.",

    promptGuidelines: [
      "Use a subagent for self-contained tasks that fit its description, and do not require back-and-forth with the user.",
      "Call a subagent with its name, and optionally a task.",
      "Use the exact subagent name from the Available subagents list.",
      "When calling a subagent, include all context it needs; subagents run in isolated sessions and do not automatically inherit the main conversation.",
    ],

    parameters: ToolParams,

    renderResult: (result: AgentToolResult<Update>, _opts) => {
      const update = result.details;

      if (update.type === "result") {
        const status = update.aborted
          ? "aborted"
          : update.exit === 0
            ? "completed"
            : "failed";

        return new Text(`${update.agent} (${update.turns}): ${status}`, 0, 0);
      } else {
        const text = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        return new Text(
          text || `${update.agent} (${update.turns}): running…`,
          0,
          0,
        );
      }
    },

    execute: async (
      _id,
      params,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<Update>> => {
      const agent = discovery.get(params.agent);
      if (agent) {
        const details = await runSubagent(
          ctx.cwd,
          agent,
          params.task,
          signal,
          onUpdate,
        );
        const text = details.output || details.stderr || "(no output)";

        return {
          content: [{ type: "text", text }],
          details,
        };
      } else {
        const agents = Array.from(discovery.keys()).join(", ") || "none";
        const text = `Unknown subagent '${params.agent}'. Available subagents: ${agents}.`;

        return {
          content: [{ type: "text", text }],
          details: {
            type: "result",
            agent: params.agent,
            task: params.task,
            turns: 0,
            output: "",
            stderr: text,
            exit: 1,
            aborted: false,
          },
        };
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    discovery.clear();
    for await (const agent of discover(ctx.cwd)) {
      discovery.set(agent.name, agent);
    }

    for (const agent of discovery.values()) {
      pi.registerCommand(`agent:${agent.name}`, {
        description: agent.description,
        handler: async (args, _ctx) => {
          const task = args.trim();
          pi.sendUserMessage(
            !task
              ? `Delegate to subagent ${JSON.stringify(agent.name)}.`
              : `Delegate task ${JSON.stringify(task)} to subagent ${JSON.stringify(agent.name)}.`,
          );
        },
      });
    }
  });

  // Add the discovered agents to the system prompt so the main agent is aware
  // of them and when might be useful to call them.
  pi.on("before_agent_start", async (event) => {
    if (discovery.size === 0) {
      return {};
    }

    const lines = [event.systemPrompt, "", "Available subagents:"];
    for (const [name, agent] of discovery) {
      lines.push(`- ${name}: ${agent.description}`);
    }

    return {
      systemPrompt: lines.join("\n"),
    };
  });
}

/**
 * Discover agent definitions in the filesystem.
 *
 * Looks in user-scoped (under the home directory) and project-scoped
 * directories (ancestors of the current working directory).
 *
 * Returns a mapping from command name to the agent's definition. If multiple
 * agents share the same command name, project-scoped agents take precedence
 * over user-scoped agents, and pi-specific sub-directories take precedence
 * over more general ones.
 *
 * Agents are generated in reverse precedence order: Project-scoped agents are
 * generated after user-scoped agents, and pi-specific agents are generated
 * after more general ones.
 */
async function* discover(cwd: string): AsyncGenerator<Agent> {
  const dirs: Array<{ dir: string; scope: "u" | "p" }> = [
    { dir: path.join(os.homedir(), ".agents", "agents"), scope: "u" },
    { dir: path.join(getAgentDir(), "agent", "agents"), scope: "u" },
  ];

  for (const parent of Array.from(ancestors(cwd)).reverse()) {
    dirs.push({ dir: path.join(parent, ".agents", "agents"), scope: "p" });
    dirs.push({ dir: path.join(parent, ".pi", "agents"), scope: "p" });
  }

  for (const { dir, scope } of dirs) {
    for await (const agent of agents(dir, scope)) {
      yield agent;
    }
  }
}

/** Runs a subagent process to completion and collects its final assistant output. */
async function runSubagent(
  cwd: string,
  agent: Agent,
  task: string | undefined,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<Update>,
): Promise<Extract<Update, { type: "result" }>> {
  const proc = await subagent(cwd, agent, task, signal);

  const result: Extract<Update, { type: "result" }> = {
    type: "result",
    agent: agent.name,
    task: task,
    turns: 0,
    output: "",
    stderr: "",
    exit: -1,
    aborted: false,
  };

  const progress: Extract<Update, { type: "partial" }> = {
    type: "partial",
    agent: agent.name,
    turns: 0,
    update: "starting…",
  };

  const update = (patch: Partial<Extract<Update, { type: "partial" }>>) => {
    // Do not set the update field to an empty or whitespace-only string.
    const next = { ...patch };
    if ("update" in next && !next.update?.trim()) {
      delete next.update;
    }

    Object.assign(progress, next);
    const trimmed = progress.update.trim();
    const text = !trimmed
      ? `${progress.agent} (${progress.turns})`
      : `${progress.agent} (${progress.turns}): ${trimmed}`;

    onUpdate?.({
      content: [{ type: "text", text }],
      details: { ...progress },
    });
  };

  const extract = (message: AgentMessage): string => {
    // Progress should reflect the subagent's own narration, not tool output
    // such as file contents, bash stdout, or command context messages.
    if (message.role !== "assistant") {
      return "";
    }

    return message.content
      .filter((c) => c.type === "text" || c.type === "thinking")
      .map((c) => c.type === "thinking" ? c.thinking : c.text)
      .join("\n");
  };

  const snippet = (message: string): string => {
    const flat = message.trim().replace(/\s+/g, " ");
    return flat.length > 80 ? `${flat.slice(0, 239)}…` : flat;
  };

  let stdoutBuffer = "";
  const processLine = (line: string) => {
    if (!line.trim()) return;

    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      return;
    }

    if (event.type === "agent_end") {
      update({ update: "finished" });
    } else if (event.type === "turn_start") {
      update({ turns: progress.turns + 1 });
    } else if (
      event.type === "turn_end" ||
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end"
    ) {
      const output = extract(event.message);
      if (output.trim()) {
        result.output = output;
        update({ update: snippet(result.output) });
      }
    } else if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      update({ update: `using ${event.toolName}` });
    }
  };

  proc.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });

  proc.stderr.on("data", (chunk) => {
    result.stderr += chunk.toString();
  });

  return await new Promise<Extract<Update, { type: "result" }>>((resolve) => {
    proc.once("error", (error) => {
      result.turns = progress.turns;
      result.exit = 1;
      result.stderr += `${result.stderr ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`;
      result.aborted = signal?.aborted ?? false;
      resolve(result);
    });

    proc.once("close", (code) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      result.turns = progress.turns;
      result.exit = code ?? 0;
      result.aborted = signal?.aborted ?? false;
      resolve(result);
    });
  });
}

/** Creates a dedicated `pi` process for an isolated subagent run. */
async function subagent(
  cwd: string,
  agent: Agent,
  task: string | undefined,
  signal?: AbortSignal,
): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const systemPrompt = [
    `Subagent '${agent.name}':`,
    "",
    "- You are an isolated subagent, responsible for completing a single task delegated to you.",
    "- When you are done, produce a concise final report for your caller.",
    `- Do not call the '${agent.name}' subagent to perform this same delegated task. You are already that subagent; complete the task yourself.`,
    `- Your instructions are available below, after the horizontal line break, loaded from '${agent.file}'.`,
    "- Load any relative files from the instructions as if they were relative to the agent file location.",
    "",
    "---",
    "",
    agent.prompt.trim(),
  ].join("\n");

  const taskPrompt =
    task?.trim() || "Infer a task from your subagent instructions.";

  const prompt = await temp("prompt.md", systemPrompt);
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--append-system-prompt",
    prompt.path,
    taskPrompt,
  ];

  const proc = spawn("pi", args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const abort = () => {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000).unref?.();
  };

  let removed = false;
  const remove = async () => {
    if (removed) return;
    removed = true;
    signal?.removeEventListener("abort", abort);
    await prompt.remove();
  };

  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  proc.once("close", remove);
  proc.once("error", remove);

  return proc;
}

/** Iterates over agent definitions in directory, `dir`. */
async function* agents(dir: string, scope: "u" | "p"): AsyncGenerator<Agent> {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    if (!e.isFile() || !/^[^.].*.md$/.test(e.name)) {
      continue;
    }

    const file = path.join(dir, e.name);
    const content = await fs.readFile(file, "utf8");

    let parsed: { frontmatter: Record<string, string>; body: string };
    try {
      parsed = parseFrontmatter<Record<string, string>>(content);
    } catch {
      parsed = { frontmatter: {}, body: content };
    }

    const name = parsed.frontmatter.name || path.basename(e.name, ".md");
    const desc = parsed.frontmatter.description || `Run the '${name}' subagent`;

    yield {
      name,
      description: `[${scope}] ${desc}`,
      prompt: parsed.body,
      file,
    };
  }
}

/**
 * Iterates over the ancestors of `file`, inclusive of `file`.
 *
 * Breaks if it hits the home directory (without yielding the home directory)
 * or if it hits the root directory (yielding the root directory).
 */
function* ancestors(file: string): Generator<string> {
  const home = os.homedir();

  file = path.resolve(file);
  while (file !== home) {
    yield file;
    const parent = path.dirname(file);
    if (file === parent) {
      break;
    } else {
      file = parent;
    }
  }
}

/**
 * Writes `content` to file `name` in a temporary directory.
 *
 * The returned object has a `path` that points to the written file, and a
 * `remove()` function that cleans up the containing directory.
 */
async function temp(
  name: string,
  content: string,
): Promise<{ path: string; remove: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 });

  return {
    path: file,
    remove: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
