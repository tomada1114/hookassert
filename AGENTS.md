# Project Guide

This file is the source of truth for every agent working in this repository.
Tool-specific files (`CLAUDE.md` and anything like it) add only what is specific to that
tool; they never restate what is here.

Machine-enforceable rules are not written down here either. `eslint.config.mjs`,
`tsconfig.json`, `.prettierrc.json`, `vitest.config.ts` and `pnpm-workspace.yaml` are
the source of truth for those, and running the gate is how you learn them.

Neither are the conventions of a particular kind of work. Those live in the skills under
`.agents/skills/`, one per kind of change, and load when the work you are doing calls
for them — see [Skills](#skills) for the index. What is left in this file is what has to
be true _before_ you know which task you are on: what this package is, how to check a
change, and which decisions need a human.

**Never hand-edit `.claude/skills/`** — it is a generated mirror, and a change there is
lost at the next sync. `authoring-skills` owns how a skill is authored, mirrored, and
checked.

## Overview

An ESM-only TypeScript package published to npm. Development runs on Node >= 24, while a
generated `node-library` chooses its published `engines.node` floor during bootstrap.
pnpm 11 is the package manager, used through Corepack. A package may also ship one
command entry in `src/cli.ts`; that command is not an import surface.

## Quick reference

```sh
pnpm check:quick   # format check, lint, typecheck, tests — the everyday gate
pnpm check         # the full gate, including build, docs, and packaging
pnpm fix           # ESLint autofix, then Prettier
pnpm test          # tests only
pnpm test:coverage # tests with the coverage thresholds enforced
pnpm build         # emit dist/ from src/
pnpm package:check # build and pack once, then run every artifact check
pnpm package:smoke # install the tarball into throwaway consumers and run it
pnpm docs:build    # TypeDoc into docs/api/
pnpm agents:sync   # regenerate .claude/skills/ from .agents/skills/
pnpm agents:check  # fail when the two skill trees have drifted apart
pnpm repo:labels   # create/update GitHub labels from .github/labels.yml
```

Run a single test file with `pnpm exec vitest run tests/<name>.test.ts`.

`pnpm check:quick` is the full local source gate, and CI runs those source/package
checks as separate steps, so a green run here means those are green too. `lefthook`'s
pre-commit hook runs a staged-file-scoped version of the same tools — format applied
rather than merely checked, tests limited to the ones reachable from the staged files —
before every commit. Nothing — not a hook, not a workflow — defines a check of its own;
they all call these scripts.

Development and source checks stay on Node 24. A generated `node-library` may publish a
different bare `>=N` floor through bootstrap's `--node-engines` option (default `>=24`);
the `package-floor` CI job builds and packs on Node 24, then consumes that artifact with
`node scripts/package-smoke.mjs --pack-dir .smoke` on the selected floor. That leg is
launched with `node` rather than `pnpm run` because pnpm 11 itself requires Node
`>=22.13`; with `--pack-dir` the script only spawns `node` and installs the throwaway
consumer with `npm`, which is what a consumer at the published floor actually has. The
override is only for that compatibility check. Never relax `devEngines.runtime`'s
`onFail: error` for normal development or source checks.

## Validating a change

Run the narrowest check that can fail, then the gate. Reaching for `pnpm check` on every
edit is slow enough that it stops being run at all.

| What you changed                       | The narrowest check that can fail                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| A module under `src/`                  | `pnpm exec vitest run tests/<module>.test.ts`                                     |
| Anything reachable from `src/index.ts` | `pnpm check` — only `package:smoke` sees the published `.d.ts` as a consumer does |
| A test                                 | `pnpm exec vitest run tests/<name>.test.ts`                                       |
| A script under `scripts/`              | `pnpm exec vitest run tests/<script>.test.ts`                                     |
| TSDoc comments                         | `pnpm docs:build`                                                                 |
| A skill under `.agents/skills/`        | `pnpm agents:sync && pnpm agents:check && pnpm test`                              |
| `package.json`, `pnpm-workspace.yaml`  | `pnpm install`, then `pnpm check`                                                 |
| Markdown                               | `pnpm fix`                                                                        |

## Architecture

```
src/
├── index.ts        # the public contract: the only module consumers can import
├── types.ts        # the published type vocabulary; declarations, no implementation
├── cli.ts          # composition root and command entry; not an import surface
└── internal/       # private; never re-exported from index.ts
    ├── errors.ts   # HookassertError and the exit-code vocabulary
    │
    │   # the static layer — reads only, never spawns a process, never writes a file
    ├── settings/   # the three-layer concatenating merge, with provenance
    ├── spec/       # the versioned event/matcher spec and its loader
    ├── matcher/    # which hooks a given event fires, and why
    ├── fixture/    # recorded events, loaded from disk
    ├── decision/   # exit codes and hook JSON, read as the decision vocabulary
    ├── assert/     # expectations diffed against what actually happened
    ├── lint/       # rules over hook declarations
    ├── report/     # pretty, JSON, and GitHub Actions output
    │
    │   # the dynamic layer — the only code that spawns or writes
    ├── exec/       # the executor, its Spawner seam, and the version probe
    └── record/     # capture-hook insertion and zero-diff restore
```

`src/index.ts` is the single consumer-importable entry point of the published contract.
`src/cli.ts` may additionally be the command entry named by `package.json#bin`, but it
is not an import surface. `scripts/*.mjs` is repository automation that never ships.
What may appear on the import surface, and what a change to it obliges, are the
`public-api-contract` and `release-impact` skills.

`src/internal/` is split into two layers, and the split is what makes the pipeline safe
to run against someone's real settings tree. The **static layer** only reads: it never
spawns a process and never writes a file, so `explain` and `lint` can run over a project
without touching it. The **dynamic layer** is the only code that runs a hook or edits a
settings file.

**A static module never imports a dynamic one.** The pipeline flows `settings/` →
`matcher/` → `assert/` → `report/`, and where it needs a real hook's result it takes
that result as a parameter rather than reaching for the executor itself. The reverse
direction is fine: a dynamic module may read the static layer's types. `src/cli.ts` is
the composition root — the only module allowed to import both layers, and the one place
they are wired together.

Enforced by: `eslint.config.mjs`'s `boundaries/static-does-not-reach-dynamic`, a
`no-restricted-imports` zone scoped to the static directories, so a static module that
reaches into `exec/` or `record/` fails lint rather than review. `changing-gates` owns
edits to that zone; `tests/boundaries.test.ts` is what proves it is still declared.

## Skills

Each skill owns one kind of change. Load the one whose subject you are working on; each
names its own boundary with its neighbours.

| Skill                   | Load it when you are working on                                                       |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `writing-typescript`    | a module under `src/**/*.ts`                                                          |
| `designing-errors`      | an error type or an `ERR_*` code, in `src/` or `scripts/`                             |
| `writing-tests`         | the body of a test under `tests/`                                                     |
| `placing-tests`         | a new test file, a vitest project, or a coverage floor                                |
| `type-testing`          | `tests/types.test.ts` and `expectTypeOf`                                              |
| `public-api-contract`   | `src/index.ts`, `src/internal/`, or `exports`/`files`                                 |
| `release-impact`        | a PR body, its semver consequence, a `CHANGELOG.md` entry                             |
| `writing-repo-scripts`  | a `.mjs` under `scripts/`                                                             |
| `authoring-skills`      | a skill under `.agents/skills/`                                                       |
| `changing-gates`        | a CI workflow, `lefthook.yml`, or a tool config                                       |
| `managing-dependencies` | adding, bumping, or removing a package by hand (an open bot PR is `merge-dependabot`) |
| `merge-dependabot`      | landing open Dependabot or Renovate pull requests                                     |
| `updating-docs`         | `README.md`, `CONTRIBUTING.md`, or `docs/`                                            |
| `triaging-issues`       | filing, labelling, or ranking a GitHub issue                                          |

## Security and human approval

- **Commit, push, pull request, and publish always need a human.** No file this
  repository ships blocks the dangerous spellings — `--no-verify`, a plain force-push,
  `npm`/`pnpm publish`, workflow dispatch — mechanically; this instruction is the rule
  itself, not a pattern enforcing it. An agent may still carry its own personal
  permission settings on top (a Claude Code session's own `~/.claude/settings.json`, for
  instance), but that is a choice made outside this repository, not something it ships
  or requires.
- Never read or write `.env*` (the `.example`, `.sample` and `.template` variants are
  fine) or anything under `secrets/`.
- Never write a credential into a tracked file — no registry auth token, no private key.
- Every pull request states whether a release is required; `release-impact` holds the
  two literal forms and the semver call.
- `pnpm-lock.yaml` is generated by `pnpm install`, never hand-edited;
  `managing-dependencies` holds the reasoning.
- Never weaken a gate to make a run pass: no lowered coverage threshold in
  `vitest.config.ts`, no file added to `coverage.exclude` to move a number, no deleted
  security workflow, no removed `--frozen-lockfile`, no removed or relaxed ESLint rule
  or `pnpm-workspace.yaml` supply-chain setting, no `@ts-ignore`, no blanket
  `eslint-disable`, no skipped or deleted test. If a gate is wrong, say so and let a
  human decide.

That last rule stays here rather than moving into a skill, because the agent it has to
reach is looking at a red run and has classified its task as "make CI green" — not as
writing a test or adding a dependency, so neither skill fires. `placing-tests` explains
why there are three separate coverage floors and `managing-dependencies` explains what
each supply-chain setting closes off; the prohibition itself is here.

## Enforcement layers

The rules above are enforced by two layers, from mechanical to procedural. Each layer
holds only what belongs there — the rule itself lives in exactly one place, never copied
between layers:

| Layer                 | Fires on              | Applies to             | Holds                                                          |
| --------------------- | --------------------- | ---------------------- | -------------------------------------------------------------- |
| `lefthook` pre-commit | `git commit`          | every author, any tool | Formatting, a related-test run, and the one content rule below |
| This file             | read at session start | every agent            | Everything else — the reasons behind the rules above           |

This repository ships no declarative, tool-call-aware layer (a Claude Code
`permissions.deny` or equivalent) — every generated project starts without one, and an
agent has that protection only if it, or the human running it, has configured it
personally, outside this repository. The one rule that must hold regardless of which
tool or human is committing — a secret about to land in history — is instead the single
mechanical layer this repository does ship: `lefthook`'s pre-commit hook, which every
author goes through the same gate for.

Two consequences of that shape are worth naming rather than discovering: a shell command
that reads a secret path outside a commit (`cat .env`, `cp .env /tmp/x`) is invisible to
the hook, since it only inspects what is staged; and turning the Git hooks off through
the environment (`LEFTHOOK=0 git commit …`) is invisible to the hook it disables, with
nothing else in the repository watching for it. Neither is enforced anywhere. "Never
read or write `.env*` or anything under `secrets/`" and "never bypass the hooks" hold as
instructions in this file, not as blocks — reaching for either spelling is the thing
being ruled out, not the spelling that happens to be caught.

`scripts/lib/guard/` is the rule engine `scripts/check-staged.mjs` (the pre-commit
layer) uses to decide whether a staged path or its content is secret-shaped. That is the
whole of its scope, on purpose.

The hook deliberately does **not** try to stop a commit from deleting a workflow,
relaxing a config, or lowering a threshold. Those are judgement calls, and a judgement
call belongs in the pull request, where a reader can weigh it and disagree — a hook
cannot. A hook that blocks legitimate work teaches its author to reach for
`--no-verify`, and that flag disables the secret check along with everything else, so a
narrow hook that never fires on intended work protects more than a broad one that has to
be routed around. "Never weaken a gate to make a run pass" therefore holds as an
instruction in this file and as something a reviewer checks, not as a block.

Hand-editing `pnpm-lock.yaml` is the clearest example of a rule this repository accepts
as unenforced rather than mechanically blocked: a regenerated lockfile (`pnpm install`)
is an ordinary, expected commit, and a git diff cannot tell that apart from a hand edit
— only a layer that sees the actual tool call that produced the change could, and none
is enforced here. "The lockfile is generated, never hand-edited" holds as an
instruction, the same way the rules above it do.

A skill holds the reasoning behind a rule and the judgment a config cannot express; it
never holds a value a config owns, and never holds a prohibition an agent would meet
while its declared task is something else.

## Conventions

- All committed code, comments, configuration, and public documentation are in English.
  `authoring-skills` applies this to a skill's `description`.

- **A comment carries only what the code cannot** — a non-obvious why, a trap the next
  edit would spring, an external constraint. Default to none and keep the rest to a line
  or two. Restating the code, or narrating decision history, is what the code and git
  already do. TSDoc on the published surface is a contract and stays.

- Do what was asked; nothing more. Prefer editing an existing file to creating a new
  one, and do not add documentation files that were not requested.
- Note improvements you spot outside the current scope instead of making them.
