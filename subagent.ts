/**
 * Isolated child-process execution for one subagent invocation.
 *
 * Execution consists of a private system-prompt file, one `pi` JSON-mode
 * process, a validated event stream, progress snapshots, cancellation with
 * termination escalation, resource cleanup, and a normalized terminal result.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Agent,
  SubagentProgress,
  SubagentResult,
  SubagentTask,
} from "./types.ts";

/**
 * Allowlist of Pi JSON-mode stdout event types.
 *
 * Informational types are accepted as no-op records. An unlisted type adds a
 * protocol diagnostic to the terminal result.
 */
const KNOWN_EVENTS = new Set([
  "session",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
]);

/** Allowlist of message roles in Pi protocol events. */
const AGENT_MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
  "compactionSummary",
]);

/** Allowlist of assistant stop reasons in Pi protocol events. */
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

/** Runtime controls for one child-process collection lifecycle. */
interface CollectOptions {
  /** Signal whose abortion requests child termination. */
  signal?: AbortSignal;

  /** Callback invoked with each immutable progress snapshot. */
  onProgress?: (progress: SubagentProgress) => void;

  /** Idempotent resource-release operation invoked during settlement. */
  cleanup?: () => Promise<void> | void;

  /** Delay between cancellation `SIGTERM` and forced `SIGKILL`. */
  killGraceMs?: number;
}

/** Mutable evidence accumulated while reading one child protocol stream. */
interface ProtocolState {
  /** Number of observed child `turn_start` events. */
  turns: number;

  /** Latest non-empty progress body, reused by metadata-only snapshots. */
  progress: string;

  /** Complete stderr collected independently from the JSON stdout protocol. */
  stderr: string;

  /** Incomplete trailing stdout line retained across stream chunks. */
  stdoutBuffer: string;

  /** One-based line counter used in protocol diagnostics. */
  stdoutLine: number;

  /** Whether a non-retrying terminal `agent_end` event was observed. */
  agentEnded: boolean;

  /** Last assistant selected from the terminal `agent_end` message list. */
  finalMessage?: AgentMessage;

  /** Latest non-empty assistant text available as fallback output. */
  latestAssistantText: string;

  /** Latest validated assistant stop reason seen in the stream. */
  stopReason?: SubagentResult["stopReason"];

  /** Latest error message supplied directly by an assistant message. */
  errorMessage?: string;

  /** Set of every adverse assistant stop reason observed in the stream. */
  badStopReasons: Set<"length" | "error" | "aborted">;

  /** Accumulated protocol, model, process, and cleanup problems. */
  diagnostics: string[];
}

/**
 * Complete child execution from private prompt creation through classified
 * settlement.
 *
 * The agent Markdown becomes an appended system prompt and the delegated task
 * becomes the user prompt of a stateless JSON print-mode `pi` process. The
 * resolved value contains the normalized process, protocol, and model outcome;
 * setup and spawn errors reject the operation.
 */
export async function runSubagent(
  cwd: string,
  agent: Agent,
  task: SubagentTask,
  signal?: AbortSignal,
  onProgress?: (progress: SubagentProgress) => void,
): Promise<SubagentResult> {
  signal?.throwIfAborted();

  const systemPrompt = [
    `Subagent '${agent.name}':`,
    "",
    "- You are an isolated subagent, responsible for completing a single task delegated to you.",
    "- When you are done, produce a concise final report for your caller.",
    `- Your instructions are available below, after the horizontal line break, loaded from '${agent.file}'.`,
    "- Load any relative files from the instructions as if they were relative to the agent file location.",
    "",
    "---",
    "",
    agent.prompt.trim(),
  ].join("\n");

  const prompt = await createTempPrompt("prompt.md", systemPrompt);
  try {
    signal?.throwIfAborted();

    const taskPrompt =
      task.task?.trim() || "Infer a task from your subagent instructions.";
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.thinking ? ["--thinking", agent.thinking] : []),
      "--append-system-prompt",
      prompt.path,
      taskPrompt,
    ];

    const proc = spawn("pi", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return await collectSubagentProcess(proc, task, {
      signal,
      onProgress,
      cleanup: prompt.remove,
    });
  } catch (error) {
    await prompt.remove();
    throw error;
  }
}

/**
 * Lifecycle promise for one spawned child process.
 *
 * Stdout is framed as newline-delimited JSON events, stderr is captured
 * verbatim, progress is emitted as immutable snapshots, cancellation escalates
 * from `SIGTERM` to `SIGKILL`, and settlement releases resources before
 * producing a normalized result.
 */
export function collectSubagentProcess(
  proc: ChildProcessByStdio<null, Readable, Readable>,
  task: SubagentTask,
  options: CollectOptions = {},
): Promise<SubagentResult> {
  const state: ProtocolState = {
    turns: 0,
    progress: "",
    stderr: "",
    stdoutBuffer: "",
    stdoutLine: 0,
    agentEnded: false,
    latestAssistantText: "",
    badStopReasons: new Set(),
    diagnostics: [],
  };

  let settled = false;
  let aborting = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;

  /**
   * Progress-snapshot emission with optional body replacement.
   *
   * A non-empty argument replaces the progress body. An omitted argument emits
   * the existing body with the current turn count, representing a metadata-only
   * update.
   */
  const emitProgress = (update?: string) => {
    const trimmed = update?.trim();
    if (trimmed) state.progress = trimmed;
    if (!state.progress) return;
    options.onProgress?.({
      ...task,
      type: "partial",
      turns: state.turns,
      update: state.progress,
    });
  };

  /**
   * Assistant-message contribution to protocol state.
   *
   * Progress consists of text and thinking blocks. Fallback output consists of
   * text blocks. Stop reason and error metadata retain their latest values, and
   * adverse stop reasons accumulate across messages.
   */
  const recordAssistant = (message: AgentMessage, showProgress = true) => {
    if (message.role !== "assistant") return;

    const progress = extractProgress(message).trim();
    const text = extractText(message).trim();
    if (text) state.latestAssistantText = text;
    if (showProgress && progress) emitProgress(progress);

    const stopReason = message.stopReason;
    state.stopReason = stopReason;
    if (
      stopReason === "length" ||
      stopReason === "error" ||
      stopReason === "aborted"
    ) {
      state.badStopReasons.add(stopReason);
    }
    if (message.errorMessage) state.errorMessage = message.errorMessage;
  };

  /** Append a protocol diagnostic while stream collection continues. */
  const protocolError = (message: string) => {
    state.diagnostics.push(message);
  };

  /** Validate and apply one parsed JSON-mode event to collector state. */
  const processEvent = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      protocolError(`Invalid JSON event on stdout line ${state.stdoutLine}`);
      return;
    }

    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string" || !KNOWN_EVENTS.has(event.type)) {
      protocolError(
        `Unknown JSON event on stdout line ${state.stdoutLine}: ${String(
          event.type,
        )}`,
      );
      return;
    }

    if (event.type === "turn_start") {
      state.turns++;
      emitProgress();
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_end"
    ) {
      if (!isAgentMessage(event.message)) {
        protocolError(
          `${event.type} omitted its message on stdout line ${state.stdoutLine}`,
        );
        return;
      }
      recordAssistant(event.message);
      return;
    }

    if (event.type === "agent_end") {
      if (!Array.isArray(event.messages)) {
        protocolError(
          `agent_end omitted messages on stdout line ${state.stdoutLine}`,
        );
        return;
      }

      for (const message of event.messages) {
        if (isAgentMessage(message)) {
          recordAssistant(message, false);
        } else {
          protocolError(
            `agent_end contained an invalid message on stdout line ${state.stdoutLine}`,
          );
        }
      }
      if (event.willRetry === true) {
        emitProgress("retrying…");
        return;
      }

      state.agentEnded = true;
      state.finalMessage = findLastAssistant(event.messages);
      if (state.finalMessage) recordAssistant(state.finalMessage, false);
      emitProgress("finished");
      return;
    }

    if (event.type === "extension_error") {
      protocolError(
        `Extension error: ${
          typeof event.error === "string" ? event.error : "unknown error"
        }`,
      );
      return;
    }

    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      if (typeof event.toolName !== "string") {
        protocolError(
          `${event.type} omitted its tool name on stdout line ${state.stdoutLine}`,
        );
        return;
      }
      emitProgress(`using ${event.toolName}`);
    }
  };

  /** Parse one complete stdout line and retain malformed input as evidence. */
  const processLine = (line: string) => {
    state.stdoutLine++;
    if (!line.trim()) return;
    try {
      processEvent(JSON.parse(line));
    } catch {
      const preview = line.length > 200 ? `${line.slice(0, 199)}…` : line;
      protocolError(
        `Malformed JSON on stdout line ${state.stdoutLine}: ${preview}`,
      );
    }
  };

  /** Frame arbitrary stdout chunks into newline-delimited protocol records. */
  const onStdout = (chunk: Buffer | string) => {
    state.stdoutBuffer += chunk.toString();
    const lines = state.stdoutBuffer.split("\n");
    state.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  };

  /** Capture stderr verbatim and independently from protocol stdout. */
  const onStderr = (chunk: Buffer | string) => {
    state.stderr += chunk.toString();
  };

  /** One-shot `SIGTERM` followed by timed `SIGKILL` escalation. */
  const abort = () => {
    if (
      settled ||
      aborting ||
      proc.exitCode !== null ||
      proc.signalCode !== null
    ) {
      return;
    }
    aborting = true;
    proc.kill("SIGTERM");

    const grace = options.killGraceMs ?? 5000;
    killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, grace);
    killTimer.unref?.();
  };

  /**
   * Idempotent release of timers, stream listeners, abort listeners, and setup
   * resources. Release errors become terminal diagnostics.
   */
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;

    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    proc.stdout.off("data", onStdout);
    proc.stderr.off("data", onStderr);

    try {
      await options.cleanup?.();
    } catch (error) {
      state.diagnostics.push(
        `Cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", onStderr);
  emitProgress("starting…");

  return new Promise((resolve) => {
    /** Settle the process-error/close race exactly once. */
    const finish = async (
      exitCode: number | null,
      processSignal: NodeJS.Signals | null,
      processError?: unknown,
    ) => {
      if (settled) return;
      settled = true;

      if (state.stdoutBuffer.trim()) processLine(state.stdoutBuffer);
      state.stdoutBuffer = "";
      if (processError) {
        state.diagnostics.push(
          `Process error: ${
            processError instanceof Error
              ? processError.message
              : String(processError)
          }`,
        );
      }

      await cleanup();
      resolve(
        classifyResult(task, state, exitCode, processSignal, options.signal),
      );
    };

    proc.once("error", (error) => {
      void finish(null, proc.signalCode, error);
    });

    proc.once("close", (code, processSignal) => {
      void finish(code, processSignal);
    });

    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Terminal result derived from process, protocol, and model evidence.
 *
 * `completed` requires a normal process exit with code zero, a terminal
 * `agent_end`, and a final textual assistant response with a `stop` reason.
 * Parent or model
 * cancellation produces `aborted`; every other invalid outcome produces
 * `failed`. Output is the final assistant text when present and otherwise the
 * latest assistant text.
 */
function classifyResult(
  task: SubagentTask,
  state: ProtocolState,
  exitCode: number | null,
  processSignal: NodeJS.Signals | null,
  parentSignal?: AbortSignal,
): SubagentResult {
  const diagnostics = [...state.diagnostics];
  const finalMessage = state.finalMessage;
  const finalText = finalMessage ? extractText(finalMessage).trim() : "";
  const output = finalText || state.latestAssistantText;
  const finalHasToolCall =
    finalMessage?.role === "assistant" &&
    finalMessage.content.some((content) => content.type === "toolCall");

  const processSucceeded = exitCode === 0 && processSignal === null;

  if (!state.agentEnded) diagnostics.push("Missing agent_end event");

  if (!finalMessage) {
    diagnostics.push("Missing final assistant response");
  } else if (finalHasToolCall) {
    diagnostics.push("Final assistant response still requested tools");
  }

  if (
    finalMessage?.role === "assistant" &&
    finalMessage.stopReason !== "stop" &&
    !state.badStopReasons.has(
      finalMessage.stopReason as "length" | "error" | "aborted",
    )
  ) {
    diagnostics.push(
      `Final assistant stop reason was ${String(finalMessage.stopReason)}`,
    );
  }

  if (!finalText)
    diagnostics.push("Final assistant response contained no text");

  if (state.badStopReasons.has("length")) {
    diagnostics.push("Model output hit its length limit");
  }

  if (state.badStopReasons.has("error"))
    diagnostics.push("Model reported an error");

  if (state.errorMessage)
    diagnostics.push("Assistant reported an error message");

  const aborted =
    parentSignal?.aborted === true || state.badStopReasons.has("aborted");
  const status = aborted
    ? "aborted"
    : processSucceeded && diagnostics.length === 0
      ? "completed"
      : "failed";

  return {
    ...task,
    type: "result",
    status,
    turns: state.turns,
    output,
    stderr: state.stderr,
    stopReason: state.stopReason,
    errorMessage: state.errorMessage,
    diagnostics,
  };
}

/** Runtime validator for supported Pi protocol message shapes. */
function isAgentMessage(value: unknown): value is AgentMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    !("role" in value) ||
    typeof value.role !== "string"
  ) {
    return false;
  }

  if (!AGENT_MESSAGE_ROLES.has(value.role)) return false;
  if (value.role !== "assistant") return true;

  if (
    !("content" in value) ||
    !Array.isArray(value.content) ||
    !("stopReason" in value) ||
    typeof value.stopReason !== "string" ||
    !STOP_REASONS.has(value.stopReason)
  ) {
    return false;
  }

  return value.content.every((content) => {
    if (
      typeof content !== "object" ||
      content === null ||
      !("type" in content)
    ) {
      return false;
    }
    if (content.type === "text")
      return "text" in content && typeof content.text === "string";
    if (content.type === "thinking") {
      return "thinking" in content && typeof content.thinking === "string";
    }
    return content.type === "toolCall";
  });
}

/** Select the last valid assistant from a terminal `agent_end` message list. */
function findLastAssistant(messages: unknown[]): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isAgentMessage(message) && message.role === "assistant") return message;
  }
  return undefined;
}

/** Newline-joined text blocks from an assistant message. */
function extractText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

/** Newline-joined text and thinking blocks from an assistant message. */
function extractProgress(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((content) => content.type === "text" || content.type === "thinking")
    .map((content) =>
      content.type === "thinking" ? content.thinking : content.text,
    )
    .join("\n");
}

/**
 * Create a private temporary prompt and an idempotent directory-level remover.
 * The directory is `0700`, the file is `0600`, and setup failures remove any
 * partially created directory before being rethrown.
 */
export async function createTempPrompt(
  name: string,
  content: string,
): Promise<{ path: string; remove: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const file = path.join(dir, name);
  try {
    await fs.chmod(dir, 0o700);
    await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }

  let removed = false;
  return {
    path: file,
    remove: async () => {
      if (removed) return;
      removed = true;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
