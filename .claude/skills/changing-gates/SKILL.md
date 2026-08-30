---
name: changing-gates
description: >
  Covers editing a file that enforces rather than implements: hand-authoring or editing
  a .github/workflows/*.yml CI workflow, editing lefthook.yml, or changing a setting
  inside eslint.config.mjs, tsconfig*.json, vitest.config.ts, or .prettierrc.json. Use
  when a new CI job or workflow is proposed, a lefthook stage or command changes, or an
  ESLint rule or tsconfig option is added or loosened.
---

# Changing Gates

**Owns:** a change to a file that enforces rather than implements — a CI workflow,
`lefthook.yml`, or a tool config (`eslint.config.mjs`, `tsconfig*.json`,
`vitest.config.ts`, `.prettierrc.json`). **Does not own:** adding a dependency the
config then configures (`managing-dependencies`); a coverage floor's value or which
project a test joins (`placing-tests`); a `.mjs` under `scripts/` that a gate invokes
(`writing-repo-scripts`); `.github/labels.yml` (`triaging-issues`).

## The one rule every gate change shares

A gate file may narrow _what_ a tool looks at; it may never define a rule of its own.
`lefthook.yml`'s header states this for the hook layer, and it is equally true of CI,
which runs the same package scripts as separate steps (`AGENTS.md`'s Quick reference).
Adding a check therefore means adding a package script and calling it from the gate,
never inlining a command directly into a workflow step or a hook line.

## CI workflows

`tests/workflows.test.ts` encodes the mechanical half of a workflow — SHA-pinned actions
with a release-tag comment, per-job timeouts, top-level `permissions: contents: read`,
no `persist-credentials`, concurrency groups. Point at that test rather than restating
its rules.

The judgment half it cannot encode:

- A new workflow file is warranted only when the work does not belong as a job inside
  the existing `ci.yml` — a new trigger shape or a genuinely separate permission
  footprint, not a convenience split.
- `pr-label.yml` is deliberately the only workflow granted write permission. Widening
  write access to another workflow, or adding a second workflow that writes, is a
  security-relevant change and needs the same weight of review as a new write grant
  itself, not a routine CI edit.
- A PR that deletes or narrows a security-relevant workflow step (the pin, the
  `permissions` block, `persist-credentials: false`, a timeout) must state in its own
  body why the removed protection no longer applies here — silence is not sufficient
  review for that kind of change.

## `lefthook.yml`

The hook is deliberately narrow: a hook that blocks legitimate work teaches its author
to reach for `--no-verify`, which disables the secret check along with everything else
(`AGENTS.md`'s Enforcement layers). The bar for a new or changed job is therefore that
it never fires on intended, unstaged-clean work — test it against a normal commit before
relying on it to catch a bad one.

Job ordering matters and is not incidental: `format` runs alone before the parallel
group so later jobs see formatted content, and `check:staged` must see the re-staged
blobs left behind by that formatting step, not the working tree as it stood before the
commit began. Preserve that ordering across an edit rather than parallelizing it away.

## Tool configs

`eslint.config.mjs`, `tsconfig*.json`, `vitest.config.ts`, and `.prettierrc.json` each
hold their own current values — read the file rather than trusting a copy of a rule
written elsewhere. A PR that changes one of these owes three things in its own body:
which rule or option moved, why, and what now passes (or newly fails) that did not
before. That statement is what lets a reviewer weigh the change; AGENTS.md's prohibition
on weakening a gate to make a run pass governs whether the change is allowed at all, and
this skill does not restate it.
