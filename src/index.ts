/**
 * Subagents extension entrypoint.
 *
 * This extension lets the parent Pi delegate one self-contained task to a
 * markdown-defined agent running in an isolated child Pi process. It registers
 * the `subagent` tool with this public shape:
 *
 *     { agent: string, label?: string, task?: string }
 *
 * Each tool invocation owns exactly one task, child process, progress stream,
 * terminal result, renderer row, and optional overflow artifact. Independent
 * work is expressed as sibling `subagent` calls in one assistant message; Pi,
 * rather than this extension, schedules those calls concurrently and returns
 * their results in source order. The optional label distinguishes sibling calls
 * in the UI and result details but is not added to the child's prompt.
 *
 * Agent definitions are discovered when a session starts. User definitions are
 * loaded from the standard user agent directories. Definitions in ancestor
 * `.agents/agents` and `${CONFIG_DIR_NAME}/agents` directories are loaded only
 * for trusted projects. Later, nearer project definitions override earlier user
 * definitions with the same name. Every discovered agent is advertised in the
 * parent system prompt and registered as `/agent:<name>`.
 *
 * Agent files are Markdown with optional frontmatter:
 *
 *     ---
 *     name: reviewer
 *     description: Review the current work
 *     model: provider/model-id
 *     thinking: low
 *     ---
 *
 *     Review the delegated scope and return a concise report.
 *
 * A call starts `pi` in JSON print mode without a session or custom extensions,
 * preventing recursive delegation while preserving normal built-in tools and
 * filesystem effects. The agent body is appended to the child system prompt;
 * `task` is sent as the child user prompt. Model and thinking overrides come
 * only from agent frontmatter.
 *
 * Child thinking, narration, and tool activity are available as progress. A
 * successful final result contains only text selected from the terminal
 * `agent_end` response. Process, protocol, model, and cancellation failures are
 * normalized into `completed`, `failed`, or `aborted`. Model-visible reports are
 * capped at 50 KiB, with larger reports preserved in a private artifact.
 *
 * Supporting modules:
 *
 * - `types.ts` defines shared agent, task, progress, and result contracts.
 * - `discovery.ts` owns trusted filesystem discovery and precedence.
 * - `subagent.ts` owns child setup, protocol collection, cancellation, cleanup,
 *   and terminal classification.
 * - `output.ts` owns titles, diagnostics, report formatting, truncation, and
 *   artifacts.
 * - `summarize.ts` renders compact Markdown progress and collapsed content.
 */

import { Type } from "typebox";

import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getMarkdownTheme,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./discovery.ts";
import {
  formatDiagnostics,
  prepareModelOutput,
  resultSummary,
  toolHeader,
} from "./output.ts";
import { runSubagent } from "./subagent.ts";
import { Summarize } from "./summarize.ts";

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentDisplayStatus } from "./output.ts";
import type {
  Agent,
  SubagentResult,
  SubagentTask,
  SubagentUpdate,
} from "./types.ts";

/** Agents discovered on session start. */
const discovery = new Map<string, Agent>();

interface SubagentRenderState {
  metadata?: {
    turns: number;
    status: SubagentDisplayStatus;
  };
}

const ToolParams = Type.Object({
  label: Type.Optional(
    Type.String({ description: "Human-readable identity for this task" }),
  ),
  agent: Type.String({ description: "The name of the agent to run" }),
  task: Type.Optional(Type.String({ description: "Task to delegate" })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",

    description: [
      "Run one isolated agent task in the current context.",
      "Pi can run sibling subagent tool calls concurrently.",
      "The child tree is summarized and wiped on turn end, but filesystem changes persist.",
      "Model-visible output is capped at 50 KiB; truncated reports are saved to a private artifact.",
    ].join(" "),

    promptSnippet:
      "Run one isolated agent task; emit sibling calls for independent parallel tasks.",

    promptGuidelines: [
      "Use subagent for self-contained tasks that fit an available subagent's description and do not require back-and-forth with the user.",
      "Each subagent call runs exactly one task. Emit multiple sibling subagent calls in the same turn for independent parallel work.",
      "Use exact subagent names from the Available subagents list.",
      "Include all necessary context in each subagent task; subagents run in isolated sessions and do not automatically inherit the main conversation.",
      "Give concurrent subagent calls concise labels, especially when invoking the same agent more than once.",
      "Avoid concurrent subagent calls that may make conflicting filesystem changes.",
    ],

    parameters: ToolParams,

    renderCall: (args, theme, context) => {
      const task: SubagentTask = args;
      const title =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const state = context.state as SubagentRenderState;
      const metadata = state.metadata ?? {
        turns: 0,
        status: context.executionStarted ? "running" : "queued",
      };
      const header = toolHeader(task, metadata.turns, metadata.status);
      title.setText(
        theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("muted", header),
      );
      return title;
    },

    renderResult: (
      result: AgentToolResult<SubagentUpdate>,
      { expanded },
      theme,
      context,
    ) => {
      const update = result.details;
      updateRenderMetadata(
        context.state as SubagentRenderState,
        context.invalidate,
        update.turns,
        update.type === "partial" ? "running" : update.status,
      );

      if (update.type === "partial") {
        const text = update.update.trim() || "running…";
        return new Summarize(text, "", {
          color: (value) => theme.fg("toolOutput", value),
        });
      }

      if (!expanded) {
        return new Summarize(resultSummary(update), "", {
          color: (value) => theme.fg("toolOutput", value),
        });
      }

      return renderExpandedResult(update, theme);
    },

    execute: async (
      _id,
      params,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<SubagentUpdate>> => {
      const task: SubagentTask = {
        agent: params.agent,
        ...(params.label?.trim() ? { label: params.label.trim() } : {}),
        ...(params.task !== undefined ? { task: params.task } : {}),
      };
      const agent = discovery.get(task.agent);

      let result: SubagentResult;
      if (signal?.aborted) {
        result = {
          ...task,
          type: "result",
          status: "aborted",
          turns: 0,
          output: "",
          stderr:
            signal.reason instanceof Error
              ? signal.reason.message
              : String(signal.reason),
          diagnostics: ["Parent aborted before the child process started"],
        };
      } else if (!agent) {
        const available = Array.from(discovery.keys()).join(", ") || "none";
        const message = `Unknown subagent ${JSON.stringify(
          task.agent,
        )}. Available subagents: ${available}.`;
        result = {
          ...task,
          type: "result",
          status: "failed",
          turns: 0,
          output: "",
          stderr: message,
          diagnostics: [message],
        };
      } else {
        try {
          result = await runSubagent(
            ctx.cwd,
            agent,
            task,
            signal,
            (progress) => {
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: progress.update,
                  },
                ],
                details: progress,
              });
            },
          );
        } catch (error) {
          const aborted = signal?.aborted === true;
          const message =
            error instanceof Error ? error.message : String(error);
          result = {
            ...task,
            type: "result",
            status: aborted ? "aborted" : "failed",
            turns: 0,
            output: "",
            stderr: message,
            diagnostics: [
              aborted
                ? "Parent aborted before the child process started"
                : `Unable to start subagent: ${message}`,
            ],
          };
        }
      }

      const prepared = await prepareModelOutput(result);
      return {
        content: [{ type: "text", text: prepared.text }],
        details: prepared.result,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const agents = await discoverAgents(ctx.cwd, ctx.isProjectTrusted(), {
      agentDir: getAgentDir(),
      configDirName: CONFIG_DIR_NAME,
      parseFrontmatter: (content) =>
        parseFrontmatter<Record<string, string>>(content),
    });

    discovery.clear();
    for (const [name, agent] of agents) discovery.set(name, agent);

    for (const agent of discovery.values()) {
      pi.registerCommand(`agent:${agent.name}`, {
        description: agent.description,
        handler: async (args) => {
          const task = args.trim();
          pi.sendUserMessage(
            !task
              ? `Delegate to subagent ${JSON.stringify(agent.name)}.`
              : `Delegate task ${JSON.stringify(
                  task,
                )} to subagent ${JSON.stringify(agent.name)}.`,
          );
        },
      });
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (discovery.size === 0) return {};

    const lines = [event.systemPrompt, "", "Available subagents:"];
    for (const [name, agent] of discovery) {
      lines.push(`- ${name}: ${agent.description}`);
    }
    return { systemPrompt: lines.join("\n") };
  });
}

function updateRenderMetadata(
  state: SubagentRenderState,
  invalidate: () => void,
  turns: number,
  status: SubagentDisplayStatus,
): void {
  if (state.metadata?.turns === turns && state.metadata.status === status) {
    return;
  }
  state.metadata = { turns, status };
  // renderResult runs inside Pi's display update; defer to avoid re-entering it.
  queueMicrotask(invalidate);
}

function renderExpandedResult(result: SubagentResult, theme: Theme): Container {
  const container = new Container();
  if (result.output.trim()) {
    container.addChild(
      new Markdown(result.output.trim(), 0, 0, getMarkdownTheme()),
    );
  } else {
    container.addChild(
      new Text(theme.fg("muted", "(no assistant output)"), 0, 0),
    );
  }

  if (result.task?.trim()) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
    container.addChild(new Text(result.task.trim(), 0, 0));
  }

  const diagnostics = formatDiagnostics(result);
  if (diagnostics.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "Diagnostics"), 0, 0));
    container.addChild(
      new Text(
        diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n"),
        0,
        0,
      ),
    );
  }

  if (result.stderr.trim()) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "Stderr"), 0, 0));
    container.addChild(new Text(result.stderr.trimEnd(), 0, 0));
  }

  return container;
}
