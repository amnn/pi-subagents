import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codingAgentModules = path.join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
);
const nestedPackage = path.join(codingAgentModules, "brace-expansion");

let nestedPackageExists = true;
try {
  await fs.lstat(nestedPackage);
} catch (error) {
  if (error?.code === "ENOENT") nestedPackageExists = false;
  else throw error;
}

const fixedManifest = JSON.parse(
  await fs.readFile(
    path.join(root, "node_modules", "brace-expansion", "package.json"),
    "utf8",
  ),
);
if (fixedManifest.version !== "5.0.8") {
  throw new Error(
    `Expected brace-expansion 5.0.8, found ${String(fixedManifest.version)}`,
  );
}

if (nestedPackageExists) {
  await fs.rm(nestedPackage, { recursive: true, force: true });
}

const lockPath = path.join(root, "package-lock.json");
const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
const fixedLockKey = "node_modules/brace-expansion";
const nestedLockKey =
  "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
if (!lock.packages?.[fixedLockKey]) {
  throw new Error("package-lock.json does not contain brace-expansion 5.0.8");
}
lock.packages[nestedLockKey] = lock.packages[fixedLockKey];
await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

const requireFromMinimatch = createRequire(
  path.join(codingAgentModules, "minimatch", "package.json"),
);
const resolvedManifest = JSON.parse(
  await fs.readFile(
    requireFromMinimatch.resolve("brace-expansion/package.json"),
    "utf8",
  ),
);
if (resolvedManifest.version !== "5.0.8") {
  throw new Error(
    `minimatch resolved brace-expansion ${String(resolvedManifest.version)}`,
  );
}
