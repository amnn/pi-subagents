import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  collectSubagentProcess,
  createTempPrompt,
  runSubagent,
} from "../src/subagent.ts";

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { SubagentProgress } from "../src/types.ts";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    return true;
  }

  send(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  sendRaw(value: string): void {
    this.stdout.write(`${value}\n`);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

function child(
  proc: FakeProcess,
): ChildProcessByStdio<null, Readable, Readable> {
  return proc as unknown as ChildProcessByStdio<null, Readable, Readable>;
}

function assistant(
  content: unknown[],
  stopReason:
    | "pending"
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted" = "stop",
  errorMessage?: string,
): Record<string, unknown> {
  return { role: "assistant", content, stopReason, errorMessage };
}

function finalEvents(
  proc: FakeProcess,
  message: Record<string, unknown>,
): void {
  proc.send({ type: "message_end", message });
  proc.send({ type: "agent_end", messages: [message] });
}

const task = {
  agent: "nits-review",
  label: "File order",
  task: "Review files",
};

test("successful result uses only final assistant text", async () => {
  const proc = new FakeProcess();
  const progress: string[] = [];
  const pending = collectSubagentProcess(child(proc), task, {
    onProgress: (update) => progress.push(update.update),
  });

  proc.send({
    type: "session",
    version: 3,
    id: "test",
    timestamp: new Date(0).toISOString(),
    cwd: process.cwd(),
  });
  proc.send({ type: "turn_start" });
  const intermediate = assistant(
    [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "intermediate narration" },
      { type: "toolCall", id: "1", name: "read", arguments: {} },
    ],
    "toolUse",
  );
  proc.send({ type: "message_end", message: intermediate });
  proc.send({ type: "tool_execution_start", toolName: "read" });
  const final = assistant([
    { type: "thinking", thinking: "final private reasoning" },
    { type: "text", text: "final report" },
  ]);
  proc.send({ type: "message_end", message: final });
  proc.send({
    type: "agent_end",
    messages: [intermediate, final],
    willRetry: false,
  });
  proc.send({ type: "agent_settled" });
  proc.close(0);

  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.output, "final report");
  assert.equal(result.turns, 1);
  assert.equal(result.label, "File order");
  assert.doesNotMatch(result.output, /private|intermediate/);
  assert(progress.some((update) => update.includes("private reasoning")));
  assert(progress.includes("using read"));
});

test("pending stop reasons are accepted while messages stream", async () => {
  const proc = new FakeProcess();
  const progress: string[] = [];
  const pending = collectSubagentProcess(child(proc), task, {
    onProgress: (update) => progress.push(update.update),
  });

  proc.send({
    type: "message_start",
    message: assistant([], "pending"),
  });
  proc.send({
    type: "message_update",
    message: assistant([{ type: "text", text: "draft" }], "pending"),
  });
  finalEvents(proc, assistant([{ type: "text", text: "report" }]));
  proc.close(0);

  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.output, "report");
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.diagnostics, []);
  assert(progress.includes("draft"));
});

test("pending stop reasons remain invalid on terminal messages", async () => {
  const proc = new FakeProcess();
  const pending = collectSubagentProcess(child(proc), task);

  proc.send({
    type: "message_end",
    message: assistant([{ type: "text", text: "unfinished" }], "pending"),
  });
  proc.send({
    type: "agent_end",
    messages: [assistant([{ type: "text", text: "unfinished" }], "pending")],
  });
  proc.close(0);

  const result = await pending;
  assert.equal(result.status, "failed");
  assert(result.diagnostics.some((line) => line.includes("invalid message")));
});

test("turn starts update metadata without replacing progress content", async () => {
  const proc = new FakeProcess();
  const progress: SubagentProgress[] = [];
  const pending = collectSubagentProcess(child(proc), task, {
    onProgress: (update) => progress.push(update),
  });

  proc.send({ type: "turn_start" });
  proc.send({
    type: "message_end",
    message: assistant([{ type: "text", text: "working" }], "toolUse"),
  });
  proc.send({ type: "turn_start" });
  finalEvents(proc, assistant([{ type: "text", text: "report" }]));
  proc.close(0);

  const result = await pending;
  assert.equal(result.turns, 2);
  assert(
    progress.some(
      (update) => update.turns === 1 && update.update === "starting…",
    ),
  );
  assert(
    progress.some(
      (update) => update.turns === 2 && update.update === "working",
    ),
  );
  assert.equal(
    progress.some((update) => /starting turn/i.test(update.update)),
    false,
  );
});

test("nonzero, null, and signaled exits map to failed status", async (t) => {
  for (const scenario of [
    { name: "nonzero", code: 7, signal: null },
    { name: "null", code: null, signal: null },
    { name: "signal", code: null, signal: "SIGTERM" as NodeJS.Signals },
  ]) {
    await t.test(scenario.name, async () => {
      const proc = new FakeProcess();
      const pending = collectSubagentProcess(child(proc), task);
      finalEvents(proc, assistant([{ type: "text", text: "report" }]));
      proc.close(scenario.code, scenario.signal);
      const result = await pending;
      assert.equal(result.status, "failed");
      assert.equal(result.output, "report");
      assert.deepEqual(result.diagnostics, []);
    });
  }
});

test("model error, aborted, and length stop reasons are not successful", async (t) => {
  for (const stopReason of ["error", "aborted", "length"] as const) {
    await t.test(stopReason, async () => {
      const proc = new FakeProcess();
      const pending = collectSubagentProcess(child(proc), task);
      finalEvents(
        proc,
        assistant(
          [{ type: "text", text: "partial report" }],
          stopReason,
          stopReason === "error" ? "provider failed" : undefined,
        ),
      );
      proc.close(0);
      const result = await pending;
      assert.equal(
        result.status,
        stopReason === "aborted" ? "aborted" : "failed",
      );
      assert.equal(result.output, "partial report");
      assert.equal(result.stopReason, stopReason);
    });
  }
});

test("malformed and unknown events fail an otherwise successful process", async () => {
  const proc = new FakeProcess();
  const pending = collectSubagentProcess(child(proc), task);
  proc.sendRaw("not-json");
  proc.send({ type: "future_event" });
  finalEvents(proc, assistant([{ type: "text", text: "report" }]));
  proc.close(0);

  const result = await pending;
  assert.equal(result.status, "failed");
  assert(result.diagnostics.some((line) => line.includes("Malformed JSON")));
  assert(
    result.diagnostics.some((line) => line.includes("Unknown JSON event")),
  );
});

test("missing agent_end or final text fails", async (t) => {
  await t.test("missing agent_end", async () => {
    const proc = new FakeProcess();
    const pending = collectSubagentProcess(child(proc), task);
    proc.send({
      type: "message_end",
      message: assistant([{ type: "text", text: "partial" }]),
    });
    proc.close(0);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.equal(result.output, "partial");
    assert(result.diagnostics.includes("Missing agent_end event"));
  });

  await t.test("missing final text", async () => {
    const proc = new FakeProcess();
    const pending = collectSubagentProcess(child(proc), task);
    finalEvents(proc, assistant([{ type: "thinking", thinking: "secret" }]));
    proc.close(0);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.equal(result.output, "");
    assert(
      result.diagnostics.includes("Final assistant response contained no text"),
    );
  });
});

test("a final tool-use message is not accepted as a report", async () => {
  const proc = new FakeProcess();
  const pending = collectSubagentProcess(child(proc), task);
  finalEvents(
    proc,
    assistant(
      [
        { type: "text", text: "I need another read" },
        { type: "toolCall", id: "1", name: "read", arguments: {} },
      ],
      "toolUse",
    ),
  );
  proc.close(0);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert(
    result.diagnostics.some((line) => line.includes("still requested tools")),
  );
});

test("an already-aborted call is rejected before spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runSubagent(
      process.cwd(),
      {
        name: "test",
        description: "test",
        prompt: "test",
        file: "/tmp/test-agent.md",
      },
      task,
      controller.signal,
    ),
    { name: "AbortError" },
  );
});

test("parent abort terminates, escalates, and cleans up once", async () => {
  const proc = new FakeProcess();
  const controller = new AbortController();
  let cleanupCalls = 0;
  let removedListeners = 0;
  const removeEventListener = controller.signal.removeEventListener.bind(
    controller.signal,
  );
  controller.signal.removeEventListener = (
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    removedListeners++;
    return removeEventListener(type, callback, options);
  };

  const pending = collectSubagentProcess(child(proc), task, {
    signal: controller.signal,
    killGraceMs: 5,
    cleanup: () => {
      cleanupCalls++;
    },
  });

  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"]);
  proc.close(null, "SIGKILL");

  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.equal(cleanupCalls, 1);
  assert.equal(removedListeners, 1);
});

test("settlement clears the abort escalation timer", async () => {
  const proc = new FakeProcess();
  const controller = new AbortController();
  const pending = collectSubagentProcess(child(proc), task, {
    signal: controller.signal,
    killGraceMs: 5,
  });

  controller.abort();
  proc.close(null, "SIGTERM");
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(proc.kills, ["SIGTERM"]);
});

test("runSubagent spawns one child and removes its prompt after close", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-spawn-test-"));
  const bin = path.join(root, "bin");
  const capture = path.join(root, "argv.json");
  await fs.mkdir(bin);
  const fakePi = path.join(bin, "pi");
  await fs.writeFile(
    fakePi,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.SUBAGENT_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
const message = { role: "assistant", content: [{ type: "text", text: "spawned report" }], stopReason: "stop" };
console.log(JSON.stringify({ type: "session", version: 3, id: "test", timestamp: new Date(0).toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "agent_end", messages: [message], willRetry: false }));
console.log(JSON.stringify({ type: "agent_settled" }));
`,
    { mode: 0o700 },
  );

  const previousPath = process.env.PATH;
  const previousCapture = process.env.SUBAGENT_ARGV_CAPTURE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SUBAGENT_ARGV_CAPTURE = capture;
  try {
    const result = await runSubagent(
      root,
      {
        name: "test",
        description: "test",
        prompt: "Review carefully.",
        file: path.join(root, "test-agent.md"),
      },
      { agent: "test", label: "Spawn", task: "Do one thing" },
    );
    assert.equal(result.status, "completed");
    assert.equal(result.output, "spawned report");

    const args = JSON.parse(await fs.readFile(capture, "utf8")) as string[];
    assert(args.includes("--no-extensions"));
    assert.equal(args.at(-1), "Do one thing");
    const promptPath = args[args.indexOf("--append-system-prompt") + 1];
    await assert.rejects(fs.stat(promptPath), { code: "ENOENT" });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.SUBAGENT_ARGV_CAPTURE;
    else process.env.SUBAGENT_ARGV_CAPTURE = previousCapture;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("temporary prompt cleanup is private and idempotent", async () => {
  const prompt = await createTempPrompt("prompt.md", "secret");
  assert.equal((await fs.stat(prompt.path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(prompt.path))).mode & 0o777, 0o700);
  await prompt.remove();
  await prompt.remove();
  await assert.rejects(fs.stat(prompt.path), { code: "ENOENT" });
});

test("process error and close race settles and cleans up once", async () => {
  const proc = new FakeProcess();
  let cleanupCalls = 0;
  const pending = collectSubagentProcess(child(proc), task, {
    cleanup: async () => {
      cleanupCalls++;
    },
  });

  proc.fail(new Error("spawn failed"));
  proc.close(1);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(cleanupCalls, 1);
  assert(result.diagnostics.some((line) => line.includes("spawn failed")));
});
