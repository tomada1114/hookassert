---
name: updating-docs
description: >
  Decides whether a change needs a documentation update and which surface it lands on —
  README.md, docs/**, TSDoc in src/**, or CHANGELOG.md — for edits touching
  src/index.ts, README.md, CONTRIBUTING.md, or docs/**. Use when triaging whether a PR
  needs a doc change, updating the README example after an API change, or deciding if an
  internal refactor needs no docs at all.
---

# Updating Documentation

**Owns:** whether a change needs a documentation update, and which surface it lands on.
**Does not own:** the release-impact note and CHANGELOG entries (`release-impact`);
TSDoc release tags (`public-api-contract`).

## Decide on observability, not location

Documentation impact is decided by what a **user can observe**, not by which directory
the edit began in. An internal refactor, a test-only change, and skill maintenance under
`.agents/skills/` or `.claude/skills/` need no documentation change — say so explicitly.
Deciding that nothing is needed is a legitimate outcome of this skill, not a shortcut to
be double-checked away.

A change is user-observable when it alters a signature, a default, an observable runtime
behavior, an error's `code`, a supported Node version, or an installation step. If none
of those moved, stop here.

## Sweep the right surfaces

When a change is user-observable, sweep every surface it touches — do not stop at the
first one that seems relevant:

- The README example, if the change affects what it shows.
- The affected pages under `docs/**` (hand-written pages, not `docs/api/`).
- TSDoc comments in `src/**` for the symbol that changed.
- CHANGELOG.md, when the change implies a release. **REQUIRED:** follow `release-impact`
  for the note and the entry itself; this skill only flags that one is owed.

**REQUIRED:** `release-impact`'s same-PR checklist is what requires the README example
and any affected `docs/` page to land in the same pull request as a public-API change;
this skill decides which surface the update belongs on, not whether one is owed.

## Purpose per file

Each file has one job; do not blur them:

- `README.md` — the value proposition readable in 30 seconds, the install command, a
  minimal working example, supported Node/runtime versions, and a pointer to the full
  API reference. Nothing more.
- `CONTRIBUTING.md` — local setup, the main `pnpm` commands, how to run tests, release
  intent, and the PR process.
- `CHANGELOG.md` — owned by release pull requests; `release-impact` holds its
  categories, its Prettier-ignore, and how an entry is worded.

## What belongs in prose

Document non-obvious behavior, architecture decisions, and trade-offs. Do not restate
what the code or the type system already says — the same principle TSDoc follows in
`src/**`. If a reader could get the fact from the signature or from running the code, it
does not need a sentence here.

## Code examples must compile

Every fenced `ts` example in README.md and every `@example` block in `src/**` is
compiled against the current public API by `tests/docs.test.ts` — do not invent a second
synchronization mechanism (a lint rule, a manual checklist item) to cover the same
ground; that test is the gate. A change to `src/index.ts` that breaks a documented
snippet fails that test, and the fix is to update the snippet in the same commit as the
signature change, not to adjust the test.

## Generated trees are off-limits

`docs/api/` is TypeDoc output (`pnpm docs:build`, configured by `typedoc.json`). It is
generated and gitignored — never hand-edit it, and never include it in a documentation
sweep. To change what it says, edit the TSDoc comments on the exported symbol in
`src/**` and regenerate; the generated file itself carries no independent content to
review.
