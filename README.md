# Subagents Extension

This Pi package runs one markdown-defined agent task in one isolated child Pi
process. Independent work is expressed as sibling `subagent` tool calls; Pi owns
concurrent scheduling while each call owns its child lifecycle, progress, result,
and renderer row.

## Development setup

The repository requires Node, npm, and Pi. Tests run TypeScript directly with
Node's type stripping; the current setup uses Node 23. Node may print an
experimental type-stripping warning.

Install the locked development dependencies:

```bash
npm ci
```

The development dependencies include the same Pi packages imported by the
extension, so standalone Node tests use normal package resolution. Pi 0.82.1's
published shrinkwrap pins a vulnerable nested `brace-expansion`; `postinstall`
deduplicates it to the direct 5.0.8 pin, and `npm run audit` verifies the
resolved tree.

## Run the unit tests

```bash
npm test
```

The suite uses temporary directories and fake child processes. It does not make
real model requests. One integration-style test places a fake `pi` executable
on `PATH` to verify child arguments and prompt cleanup.

Run one file:

```bash
node --test test/subagent.test.ts
```

Run tests matching a name:

```bash
node --test --test-name-pattern="parent abort" test/subagent.test.ts
```

Test coverage is grouped as follows:

- `test/discovery.test.ts` — project trust and source precedence
- `test/subagent.test.ts` — protocol, outcomes, cancellation, and cleanup
- `test/output.test.ts` — titles, reports, truncation, and artifacts

## Type-check

```bash
npm run typecheck
```

## Check formatting

```bash
npm run format:check
```

To apply formatting:

```bash
npm run format
```

## Smoke-test extension loading

```bash
npm run smoke
```

The smoke test loads only this extension in offline mode and exits without a
model request.

## Full local validation

```bash
npm run check && npm run smoke
```

## Install as a local Pi package

The package manifest declares `index.ts` as its extension entrypoint. Keep the
repository outside Pi's auto-discovered `~/.pi/agent/extensions` directory,
install its development dependencies, and register its absolute path:

```bash
cd /absolute/path/to/pi-subagents
npm ci
pi install /absolute/path/to/pi-subagents
```

Pi records the local package in user settings and loads the extension directly
from the checkout. Changes take effect after `/reload` or a Pi restart.

Confirm the installation with:

```bash
pi list
```
