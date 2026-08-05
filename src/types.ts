// Copyright (c) Ashok Menon
// SPDX-License-Identifier: Apache-2.0

/**
 * Domain contracts shared by the subagent extension modules.
 *
 * A tool invocation moves through one simple lifecycle:
 *
 *     SubagentTask -> zero or more SubagentProgress values -> SubagentResult
 *
 * `index.ts` adapts these contracts to Pi's tool API and renderer,
 * `discovery.ts` produces `Agent` definitions, `subagent.ts` produces progress
 * and terminal results, and `output.ts` formats terminal results for the parent
 * model and overflow artifacts.
 *
 * These types deliberately contain no batch or scheduler state. One set of
 * values describes one Pi tool call and its one child process; Pi coordinates
 * concurrency between sibling calls.
 */

/** A parsed markdown agent definition that can be launched as a child Pi. */
export interface Agent {
  /**
   * Stable public name used for discovery-map lookup, the `agent` tool
   * parameter, `/agent:<name>` commands, child prompt identity, and UI titles.
   */
  name: string;

  /**
   * Human-readable purpose advertised in the parent system prompt and used as
   * the matching slash command's description. Discovery prefixes this with the
   * source scope (`[u]` or `[p]`).
   */
  description: string;

  /**
   * Markdown body from the definition file. `runSubagent()` appends it to the
   * isolated child's system prompt; it is not copied into model-visible tool
   * results.
   */
  prompt: string;

  /**
   * Absolute path of the definition file. The child system prompt cites this
   * path so instructions can resolve referenced files relative to their source.
   */
  file: string;

  /** Optional frontmatter model passed to the child Pi as `--model`. */
  model?: string;

  /** Optional frontmatter thinking level passed to child Pi as `--thinking`. */
  thinking?: string;
}

/**
 * Canonical identity and input for one `subagent` tool invocation.
 *
 * `index.ts` constructs this after normalizing tool arguments. It is copied
 * into every progress update and the terminal result so rendering, diagnostics,
 * and model-visible output always refer to the same call.
 */
export interface SubagentTask {
  /** Agent definition name used for lookup and retained as result identity. */
  agent: string;

  /**
   * Delegated user prompt passed to the child Pi. When omitted or blank,
   * `runSubagent()` asks the child to infer a task from its agent instructions.
   */
  task?: string;

  /**
   * Optional human-readable identity for distinguishing otherwise similar
   * sibling calls. It appears in titles and result details but is not added to
   * the child's delegated prompt automatically.
   */
  label?: string;
}

/**
 * Non-terminal snapshot emitted while the child is running.
 *
 * `subagent.ts` sends these through its progress callback; `index.ts` forwards
 * them as Pi partial tool results and uses them to update the live title and
 * collapsed body. Progress may contain thinking or intermediate narration and
 * must never be treated as the successful final report.
 */
export interface SubagentProgress extends SubagentTask {
  /** Discriminant used by the renderer to select the streaming path. */
  type: "partial";

  /** Number of child `turn_start` protocol events observed so far. */
  turns: number;

  /**
   * Latest concise progress content, such as assistant narration, `starting…`,
   * `retrying…`, or `using bash`. A snapshot may repeat this content when only
   * the turn count changes. Identity, turn count, and status are rendered
   * separately in the tool title.
   */
  update: string;
}

/**
 * Terminal evidence and normalized outcome for one child process.
 *
 * `collectSubagentProcess()` constructs this after process settlement,
 * `index.ts` stores it in final tool-result details and renders it, and
 * `output.ts` turns it into the bounded report visible to the parent model.
 * Process termination is normalized into `status`; callers should use that
 * status rather than attempting to reconstruct an outcome from raw evidence.
 */
export interface SubagentResult extends SubagentTask {
  /** Discriminant used by renderers and output code for the terminal path. */
  type: "result";

  /**
   * Sole normalized terminal outcome. `completed` requires a clean process,
   * valid protocol, and final assistant text; `aborted` represents parent or
   * model cancellation; every other invalid terminal condition is `failed`.
   */
  status: "completed" | "failed" | "aborted";

  /** Total number of child `turn_start` events observed before settlement. */
  turns: number;

  /**
   * Assistant report text. For `completed`, this is exclusively text from the
   * final assistant selected at terminal `agent_end`. Failed or aborted calls
   * may retain the latest partial assistant text for diagnosis.
   */
  output: string;

  /** Complete stderr captured from the child process, without normalization. */
  stderr: string;

  /**
   * Latest validated terminal assistant stop reason observed in the JSON protocol.
   * `length`, `error`, and `aborted` affect terminal classification, while a
   * terminal `toolUse` indicates that the purported final response was not done.
   */
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";

  /** Error text supplied directly by an assistant protocol message, if any. */
  errorMessage?: string;

  /**
   * Ordered human-readable protocol, model, and cleanup problems gathered while
   * collecting and classifying the child. This is normally empty on success and
   * is preserved in expanded UI and model-visible failure reports.
   */
  diagnostics: string[];

  /**
   * Absolute path to a private full-report artifact created by `output.ts` when
   * the formatted model-visible result exceeds 50 KiB. The underlying output
   * and diagnostics remain present on this result as well.
   */
  artifactPath?: string;
}

/**
 * Detail payload used by both partial and final Pi tool results.
 * Consumers branch on `type`; queued/running state is renderer-local and is not
 * represented as a fake terminal result.
 */
export type SubagentUpdate = SubagentProgress | SubagentResult;
