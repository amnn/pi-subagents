import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Dirent } from "node:fs";
import type { Agent } from "./types.ts";

export interface DiscoveryOptions {
  agentDir: string;
  configDirName: string;
  homeDir?: string;
  parseFrontmatter: (content: string) => {
    frontmatter: Record<string, string>;
    body: string;
  };
}

/** Discover user agents and, for trusted projects, project-controlled agents. */
export async function discoverAgents(
  cwd: string,
  trusted: boolean,
  options: DiscoveryOptions,
): Promise<Map<string, Agent>> {
  const home = options.homeDir ?? os.homedir();
  const dirs: Array<{ dir: string; scope: "u" | "p" }> = [
    { dir: path.join(home, ".agents", "agents"), scope: "u" },
    { dir: path.join(options.agentDir, "agents"), scope: "u" },
  ];

  if (trusted) {
    for (const parent of Array.from(ancestors(cwd)).reverse()) {
      dirs.push({ dir: path.join(parent, ".agents", "agents"), scope: "p" });
      dirs.push({
        dir: path.join(parent, options.configDirName, "agents"),
        scope: "p",
      });
    }
  }

  const discovered = new Map<string, Agent>();
  for (const { dir, scope } of dirs) {
    for await (const agent of agents(dir, scope, options)) {
      discovered.set(agent.name, agent);
    }
  }
  return discovered;
}

async function* agents(
  dir: string,
  scope: "u" | "p",
  options: DiscoveryOptions,
): AsyncGenerator<Agent> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (
      (!entry.isFile() && !entry.isSymbolicLink()) ||
      !/^[^.].*\.md$/.test(entry.name)
    ) {
      continue;
    }

    const file = path.join(dir, entry.name);
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    let parsed: { frontmatter: Record<string, string>; body: string };
    try {
      parsed = options.parseFrontmatter(content);
    } catch {
      parsed = { frontmatter: {}, body: content };
    }

    const name = parsed.frontmatter.name || path.basename(entry.name, ".md");
    const description =
      parsed.frontmatter.description || `Run the '${name}' subagent`;

    yield {
      name,
      description: `[${scope}] ${description}`,
      prompt: parsed.body,
      file,
      model: parsed.frontmatter.model,
      thinking: parsed.frontmatter.thinking,
    };
  }
}

/** Iterate ancestors, excluding the home directory and including filesystem root. */
export function* ancestors(
  file: string,
  home = os.homedir(),
): Generator<string> {
  file = path.resolve(file);
  while (file !== home) {
    yield file;
    const parent = path.dirname(file);
    if (file === parent) break;
    file = parent;
  }
}
