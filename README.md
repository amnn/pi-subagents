# Subagents Extension

This Pi package runs one markdown-defined agent task in one isolated child Pi
process. Independent work is expressed as sibling `subagent` tool calls; Pi owns
concurrent scheduling while each call owns its child lifecycle, progress, result,
and renderer row.

## Installation

Install the published package from npm:

```bash
pi install npm:@am_n_n/pi-subagents
```

Confirm the installation with `pi list`. Changes from package updates take effect
after `/reload` or a Pi restart.

## Development setup

Development requires Node.js 22.19 or newer, pnpm, and Pi. The repository's
`devEngines` configuration pins the pnpm version and lets pnpm download it when
necessary. Tests run TypeScript directly through `tsx`.

Install the locked development dependencies:

```bash
pnpm install
```

The development dependencies include the same Pi packages imported by the
extension, so standalone Node tests use normal package resolution. This project
uses pnpm exclusively; installs from other package managers are rejected.

## Run the unit tests

```bash
pnpm test
```

The suite uses temporary directories and fake child processes. It does not make
real model requests. One integration-style test places a fake `pi` executable
on `PATH` to verify child arguments and prompt cleanup.

Run one file:

```bash
pnpm exec tsx --test test/subagent.test.ts
```

Run tests matching a name:

```bash
pnpm exec tsx --test --test-name-pattern="parent abort" test/subagent.test.ts
```

Test coverage is grouped as follows:

- `test/discovery.test.ts` — project trust and source precedence
- `test/subagent.test.ts` — protocol, outcomes, cancellation, and cleanup
- `test/output.test.ts` — titles, reports, truncation, and artifacts

## Type-check

```bash
pnpm typecheck
```

## Check formatting

```bash
pnpm format:check
```

To apply formatting:

```bash
pnpm format
```

## Smoke-test extension loading

```bash
pnpm smoke
```

The smoke test loads only this extension in offline mode and exits without a
model request.

## Full local validation

```bash
pnpm check
```

The full check verifies formatting, type-checks the package, runs the tests,
smoke-tests extension loading, and audits dependencies.

## Install from a checkout

The package manifest declares `index.ts` as its extension entrypoint. Keep the
repository outside Pi's auto-discovered `~/.pi/agent/extensions` directory,
install its development dependencies, and register its absolute path:

```bash
cd /absolute/path/to/pi-subagents
pnpm install
pi install /absolute/path/to/pi-subagents
```

Pi records the local package in user settings and loads the extension directly
from the checkout. Changes take effect after `/reload` or a Pi restart.

Confirm the installation with:

```bash
pi list
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
