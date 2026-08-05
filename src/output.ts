// Copyright (c) Ashok Menon
// SPDX-License-Identifier: Apache-2.0

/**
 * Formatting, size bounding, and private artifact storage for terminal
 * subagent results.
 *
 * A result has compact-summary, complete-Markdown, and byte-bounded Markdown
 * representations. Oversized Markdown retains its complete representation in
 * a private temporary artifact.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SubagentResult, SubagentTask } from "./types.ts";

/** Union of queued, running, and terminal result statuses. */
export type SubagentDisplayStatus =
  | SubagentResult["status"]
  | "queued"
  | "running";

/** Default maximum UTF-8 byte length of a bounded Markdown report. */
export const MODEL_OUTPUT_LIMIT_BYTES = 50 * 1024;

/** Agent name and optional label in unadorned heading form. */
export function taskTitle(task: SubagentTask): string {
  const label = task.label?.trim();
  return label ? `${task.agent}: ${label}` : task.agent;
}

/** Agent name and optional label in parenthesized tool-identity form. */
export function toolTitle(task: SubagentTask): string {
  const label = task.label?.trim();
  return `(${task.agent})${label ? `: ${label}` : ""}`;
}

/** Protocol turn count with the correct singular or plural noun. */
export function turnCount(turns: number): string {
  return `${turns} turn${turns === 1 ? "" : "s"}`;
}

/** Tool identity followed by its turn count and display status. */
export function toolHeader(
  task: SubagentTask,
  turns: number,
  status: SubagentDisplayStatus,
): string {
  return `${toolTitle(task)} · ${turnCount(turns)} · ${status}`;
}

/**
 * First non-empty result content in output, stderr, and first-diagnostic order.
 * The fallback is `(no output)`.
 */
export function resultSummary(result: SubagentResult): string {
  return (
    result.output.trim() ||
    result.stderr.trim() ||
    result.diagnostics[0] ||
    "(no output)"
  );
}

/**
 * Complete Markdown report containing identity, turn count, terminal status,
 * assistant output, diagnostics, and stderr.
 */
export function formatFullReport(result: SubagentResult): string {
  const lines = [
    `# ${taskTitle(result)} — ${turnCount(
      result.turns,
    )} · ${result.status.toUpperCase()}`,
    "",
  ];
  lines.push(result.output.trim() || "(no assistant output)");

  const diagnostics = formatDiagnostics(result);
  if (diagnostics.length > 0) {
    lines.push(
      "",
      "## Diagnostics",
      "",
      ...diagnostics.map((line) => `- ${line}`),
    );
  }

  if (result.stderr.trim()) {
    lines.push("", "## Stderr", "", "```text", result.stderr.trimEnd(), "```");
  }

  return lines.join("\n");
}

/**
 * Ordered unique diagnostics with stop reason first and model-error and
 * artifact-path metadata appended.
 */
export function formatDiagnostics(result: SubagentResult): string[] {
  const diagnostics = [...result.diagnostics];
  const add = (message: string, first = false) => {
    if (diagnostics.includes(message)) return;
    if (first) diagnostics.unshift(message);
    else diagnostics.push(message);
  };

  if (result.stopReason) add(`Stop reason: ${result.stopReason}`, true);
  if (result.errorMessage) add(`Model error: ${result.errorMessage}`);
  if (result.artifactPath) add(`Full report: ${result.artifactPath}`);
  return diagnostics;
}

/**
 * Byte-bounded representation of a complete Markdown report.
 *
 * A report at or below `maxBytes` remains complete. An oversized report becomes
 * a UTF-8-safe prefix plus the path to a private artifact containing the full
 * value. Artifact-creation failure produces a `failed` result and an inline
 * truncation diagnostic.
 */
export async function prepareModelOutput(
  result: SubagentResult,
  options: { maxBytes?: number; tempRoot?: string } = {},
): Promise<{ text: string; result: SubagentResult }> {
  const maxBytes = options.maxBytes ?? MODEL_OUTPUT_LIMIT_BYTES;
  const fullReport = formatFullReport(result);
  if (Buffer.byteLength(fullReport, "utf8") <= maxBytes) {
    return { text: fullReport, result };
  }

  let artifactPath: string;
  try {
    artifactPath = await writeReportArtifact(
      fullReport,
      options.tempRoot ?? os.tmpdir(),
    );
  } catch (error) {
    const message = `Unable to preserve truncated report: ${
      error instanceof Error ? error.message : String(error)
    }`;
    const failedResult: SubagentResult = {
      ...result,
      status: "failed",
      diagnostics: [...result.diagnostics, message],
    };
    const suffix = `\n\n[Output truncated and artifact creation failed: ${message}]`;
    const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
    return {
      text: `${truncateUtf8(formatFullReport(failedResult), budget)}${suffix}`,
      result: failedResult,
    };
  }

  const nextResult = { ...result, artifactPath };
  const suffix = `\n\n[Output truncated. Full report: ${artifactPath}]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  return {
    text: `${truncateUtf8(fullReport, budget)}${suffix}`,
    result: nextResult,
  };
}

/**
 * Persist a complete report in a fresh `0700` directory and `0600` file.
 * Partial directories are removed if any write or permission operation fails.
 */
export async function writeReportArtifact(
  report: string,
  tempRoot = os.tmpdir(),
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tempRoot, "pi-subagent-report-"));
  const file = path.join(dir, "report.md");
  try {
    await fs.chmod(dir, 0o700);
    await fs.writeFile(file, report, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(file, 0o600);
    return file;
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Longest UTF-8-safe prefix whose encoded length is at most `maxBytes`.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
