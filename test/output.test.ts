import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  formatFullReport,
  prepareModelOutput,
  resultSummary,
  toolHeader,
  toolTitle,
  turnCount,
} from "../src/output.ts";

import type { SubagentResult } from "../src/types.ts";

function result(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    type: "result",
    agent: "nits-review",
    label: "File order",
    task: "A delegated prompt that should not be echoed",
    status: "completed",
    turns: 2,
    output: "final report",
    stderr: "",
    stopReason: "stop",
    diagnostics: [],
    ...overrides,
  };
}

test("tool header includes identity, turn count, and status", () => {
  assert.equal(
    toolTitle({ agent: "nits", label: "file order" }),
    "(nits): file order",
  );
  assert.equal(toolTitle({ agent: "nits" }), "(nits)");
  assert.equal(turnCount(1), "1 turn");
  assert.equal(turnCount(2), "2 turns");
  assert.equal(
    toolHeader({ agent: "nits", label: "file order" }, 2, "completed"),
    "(nits): file order · 2 turns · completed",
  );
  assert.equal(
    toolHeader({ agent: "nits" }, 0, "running"),
    "(nits) · 0 turns · running",
  );
});

test("full report and collapsed summary preserve output without echoing task", () => {
  const value = result();
  assert.equal(resultSummary(value), "final report");
  const report = formatFullReport(value);
  assert.match(report, /nits-review: File order — 2 turns · COMPLETED/);
  assert.match(report, /final report/);
  assert.doesNotMatch(report, /delegated prompt|Process exit/);
});

test("failure summary falls back through stderr and diagnostics", () => {
  assert.equal(
    resultSummary(result({ output: "", stderr: "child stderr" })),
    "child stderr",
  );
  assert.equal(
    resultSummary(result({ output: "", stderr: "", diagnostics: ["failed"] })),
    "failed",
  );
});

test("truncated output creates a private recoverable artifact", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "subagent-output-test-"),
  );
  try {
    const original = result({ output: `report ${"🙂".repeat(2000)}` });
    const prepared = await prepareModelOutput(original, {
      maxBytes: 512,
      tempRoot,
    });

    assert(prepared.result.artifactPath);
    assert.match(prepared.text, /Output truncated\. Full report:/);
    assert(Buffer.byteLength(prepared.text, "utf8") <= 512);
    assert.equal(
      await fs.readFile(prepared.result.artifactPath, "utf8"),
      formatFullReport(original),
    );

    const fileMode = (await fs.stat(prepared.result.artifactPath)).mode & 0o777;
    const dirMode =
      (await fs.stat(path.dirname(prepared.result.artifactPath))).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("artifact failure is returned as a structured failed result", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "subagent-missing-root-"),
  );
  try {
    const original = result({ output: "x".repeat(2000) });
    const prepared = await prepareModelOutput(original, {
      maxBytes: 512,
      tempRoot: path.join(root, "missing", "nested"),
    });
    assert.equal(prepared.result.status, "failed");
    assert.equal(prepared.result.artifactPath, undefined);
    assert(
      prepared.result.diagnostics.some((diagnostic) =>
        diagnostic.includes("Unable to preserve truncated report"),
      ),
    );
    assert(Buffer.byteLength(prepared.text, "utf8") <= 512);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("small output does not create an artifact", async () => {
  const original = result();
  const prepared = await prepareModelOutput(original);
  assert.equal(prepared.result, original);
  assert.equal(prepared.result.artifactPath, undefined);
});
