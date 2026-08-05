// Copyright (c) Ashok Menon
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../src/discovery.ts";

async function writeAgent(
  dir: string,
  file: string,
  name: string,
  marker: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, file),
    `---\nname: ${name}\ndescription: ${marker}\n---\n${marker}\n`,
  );
}

test("project agents load only for trusted projects and retain precedence", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "subagent-discovery-test-"),
  );
  try {
    const homeDir = path.join(root, "home");
    const agentDir = path.join(root, "pi-agent");
    const project = path.join(root, "project");
    const cwd = path.join(project, "nested");
    await fs.mkdir(cwd, { recursive: true });

    await writeAgent(
      path.join(homeDir, ".agents", "agents"),
      "shared.md",
      "shared",
      "user general",
    );

    await writeAgent(
      path.join(agentDir, "agents"),
      "shared.md",
      "shared",
      "user pi",
    );

    await writeAgent(
      path.join(agentDir, "agents"),
      "user-only.md",
      "user-only",
      "user only",
    );

    await writeAgent(
      path.join(project, ".agents", "agents"),
      "shared.md",
      "shared",
      "project general",
    );

    await writeAgent(
      path.join(project, ".pi", "agents"),
      "shared.md",
      "shared",
      "project pi",
    );

    await writeAgent(
      path.join(project, ".pi", "agents"),
      "project-only.md",
      "project-only",
      "project only",
    );

    const options = {
      homeDir,
      agentDir,
      configDirName: ".pi",
      parseFrontmatter,
    };

    const untrusted = await discoverAgents(cwd, false, options);
    assert.deepEqual([...untrusted.keys()].sort(), ["shared", "user-only"]);
    assert.match(untrusted.get("shared")!.description, /user pi/);
    assert.equal(untrusted.has("project-only"), false);

    const trusted = await discoverAgents(cwd, true, options);
    assert.deepEqual([...trusted.keys()].sort(), [
      "project-only",
      "shared",
      "user-only",
    ]);
    assert.match(trusted.get("shared")!.description, /project pi/);
    assert.match(trusted.get("project-only")!.description, /^\[p\]/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
