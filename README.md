# Subagents Extension

This Pi package runs one markdown-defined agent task in one isolated child Pi
process. Independent work is expressed as sibling `subagent` tool calls; Pi owns
concurrent scheduling while each call owns its child lifecycle, progress, result,
and renderer row.

## Installation

Install the published package from npm (recommended):

```bash
pi install npm:@am_n_n/pi-subagents
```

Alternatively, install the latest source directly from GitHub:

```bash
pi install git:github.com/amnn/pi-subagents
```

To install from a local checkout:

```bash
git clone https://github.com/amnn/pi-subagents.git
cd pi-subagents
pnpm install
pi install .
```

Confirm the installation with `pi list`. After installing an update or changing
a local checkout, run `/reload` in Pi or restart it.

## Development setup

Development requires Node.js 22.19 or newer, pnpm, and Pi. The repository's
`packageManager` field pins the pnpm version and lets pnpm download it when
necessary. Tests run TypeScript directly through `tsx`.

Install the locked development dependencies:

```bash
pnpm install
```

The development dependencies include the same Pi packages imported by the
extension, so standalone Node tests use normal package resolution. This project
uses pnpm for development; `pnpm-lock.yaml` is its only supported lockfile.

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

## License

Apache License 2.0. See [LICENSE](LICENSE).
