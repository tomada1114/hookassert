---
name: placing-tests
description: >
  Decides where a new test file goes under tests/<module>.test.ts, which
  vitest.config.ts project (unit vs automation) it joins, and which of the three
  coverage.thresholds floors (src/**, scripts/**, scripts/lib/guard/**) govern it. Use
  when adding a *.test.ts file, choosing between `pnpm exec vitest run` and `pnpm
  test:coverage`, or a coverage run drops below a floor.
---

# Placing Tests

**Owns:** where a new test file goes, which vitest project it joins, and the coverage
floors that govern it. **Does not own:** how the test itself is written, assertion
style, and fixtures (`writing-tests`); type tests with `expectTypeOf` (`type-testing`).

## Location

- Every test file lives at `tests/<module>.test.ts`. Never co-locate a test next to the
  source file it covers.
- `tests/fixtures/` is reserved for data under test, not test modules. Keep executable
  assertions in `tests/<module>.test.ts`.
- Nothing under `tests/fixtures/` is linted, formatted, type-checked, spell-checked, or
  collected as a test — `eslint.config.mjs`, `.prettierignore`, `tsconfig.json`,
  `typos.toml` and `vitest.config.ts` all skip it, and `tests/tooling-ignores.test.ts`
  holds the five together. That is what makes the tree usable for a fixture that is
  _meant_ to be malformed or to fail, or for a whole project belonging to another
  toolchain, driven from an `automation` test as a child process.

## Choosing a project

`vitest.config.ts` splits `test.projects` into `unit` and `automation`. Placement is a
decision you make from what the file touches, never from its name or its directory. The
unit project includes `tests/**/*.test.ts` by default; the automation project is the
explicit `automationTests` list at the top of `vitest.config.ts`. A new test therefore
starts in `unit`, and you add its path to `automationTests` when it needs I/O. Choose
between them by:

- **`unit`** — the test imports only `src/**` (plus, as a deliberate exception,
  `scripts/lib/guard/**`'s own pure-function tests) and touches no filesystem,
  subprocess, or git.
- **`automation`** — everything else: any test that shells out, reads or writes a temp
  directory, or spawns `git`/`node`.

The two directions fail differently, which is the point of listing `automation`
explicitly. Forgetting to register a test that does I/O leaves it in `unit`, where the
5-second budget makes it time out loudly rather than pass on a budget nobody chose.
Listing a pure test in `automationTests` is the quiet mistake: it still passes, just on
a budget far longer than it needs. Keep pure tests in the default unit project and edit
the explicit `automationTests` list when a test gains filesystem, subprocess, or git
work.

- **Why the timeouts differ:** a `unit` test has no I/O, so if it hangs the only
  possible cause is an infinite loop or an unresolved promise, and a short timeout
  surfaces that in seconds. An `automation` test legitimately needs the long budget for
  a real subprocess or temp-directory operation — giving it the short one would make
  correct tests flaky.

## CLI entry tests

A command's test seam is the CLI entry itself: drive `argv` and observe the exit code,
stdout, and stderr. For `src/cli.ts`, the conventional location is `tests/cli.test.ts`,
not `src/internal/` and not a second public package entry. An in-process entry test that
imports only `src/cli.ts` and touches no I/O belongs to the `unit` project; a test that
starts the command as a child process or uses a temporary consumer belongs to
`automation`.

## Coverage floors

`coverage.include` in `vitest.config.ts` lists both `src/**/*.ts` and `scripts/**/*.mjs`
on purpose: a file with no test still counts toward the denominator at 0% instead of
vanishing from it. A new file is covered from the moment it exists — write its test in
the same PR, not as follow-up.

Three independent threshold sets exist, not one, because they answer three different
questions:

- **`src/**`** carries the package's own baseline floor — this is the public contract's
  coverage bar.
- **`scripts/**`** was never measured before it was added to `coverage.include`, so its
  floor is the last measured coverage rounded down to a clean value, not a guessed
  target — it has been raised as coverage grew (see the dated comments in
  `vitest.config.ts`). Raise it again as real coverage grows; never invent a number
  ahead of the measurement.
- **`scripts/lib/guard/**`** — the credential and path detection rule engine, the most
  security-critical code in the repository — carries its own higher floor on lines,
  functions, and statements, so it cannot regress just because it is dragged along by
  whatever number the broader `scripts/**` tree happens to sit at. The two trees' branch
  floors are set independently in `vitest.config.ts` and are raised as each tree's own
  measured branch coverage grows, so do not assume one bounds the other.

See `vitest.config.ts`'s `coverage.thresholds` for the current numbers; this skill
deliberately does not repeat them, since a copied number goes stale the moment the
config changes.

**Coverage stops at the process boundary.** The v8 provider instruments the Vitest
workers and nothing else, so a `src/**` module that only ever executes inside a process
the test spawns reports 0% however thoroughly the integration test exercises it — and 0%
against an 80% floor fails the run. Design for it rather than discovering it: keep the
part that runs in the child thin and put the logic behind it in a module the test can
also call in-process.

- **Branch coverage is the one that matters.** Cover both sides of a conditional rather
  than adding a trivial test whose only effect is moving a line/statement percentage.
- **A floor is never lowered, and no file is added to `coverage.exclude` to move a
  number** — AGENTS.md's "Security and human approval" holds that prohibition for every
  agent, including one whose task is only "make CI green." What this skill owns is which
  of the three floors applies and why.

## Commands

```bash
pnpm exec vitest run tests/<name>.test.ts   # one file, fast iteration
pnpm test:coverage                          # full suite with floors enforced
```

If `pnpm test:coverage` fails on a floor, add real coverage for the uncovered branch —
do not adjust the threshold or the include list.
