---
name: bootstrapping-the-template
description: >
  Covers the bootstrap flow that turns this template into a fresh package:
  scripts/bootstrap.mjs, scripts/verify-bootstrap.mjs, tests/bootstrap.test.ts,
  tests/verify-bootstrap.test.ts, the node-library/universal-library profiles, and pnpm
  bootstrap:e2e. Use when changing what bootstrap prompts for, transforms, or removes;
  adding or editing a profile; touching PLACEHOLDER_TARGETS, MARKER_TARGETS,
  AI_LAYER_TARGETS, or DANGLING_REFERENCE_EXEMPTIONS; or debugging
  ERR_AI_LAYER_REFERENCE, ERR_BOOTSTRAP_SCRIPT_REMAINING, or a bootstrap:e2e failure.
---

# Bootstrapping the Template

**Owns:** the bootstrap flow — `scripts/bootstrap.mjs`, `scripts/verify-bootstrap.mjs`,
`tests/bootstrap.test.ts`, `tests/verify-bootstrap.test.ts`, the bootstrap profiles, and
`pnpm bootstrap:e2e`. **Does not own:** the general `.mjs` import/typing/git-safety
contract every script under `scripts/` follows (`writing-repo-scripts`); test-body
conventions (`writing-tests`); where a test file lives or its coverage floor
(`placing-tests`); the published API surface (`public-api-contract`).

## The flow end to end

`scripts/bootstrap.mjs` turns a fresh clone of this template into a real package, once.
`main()` collects package metadata — interactively via `promptArguments`, or
non-interactively from `<package-name>` plus `--profile`/`--cli`/`--node-engines`/
`--author`/`--email`/`--github-user`/`--license` flags (`parseArguments`) — then calls
`bootstrap(root, options)`.

`bootstrap()` runs `transform()` twice: once as a dry-run into an in-memory `preview`
Map (never touching disk), then for real only after the dry-run passes every check
(`findPlaceholders`, `assertGeneratedAiLayer`). `transform()` itself:

- Removes its own four files — `scripts/bootstrap.mjs`, `scripts/verify-bootstrap.mjs`,
  `tests/bootstrap.test.ts`, `tests/verify-bootstrap.test.ts` — see "The self-removal
  property" below.
- Rewrites `PLACEHOLDER_TARGETS` (template package name, repo, author, email,
  description) and strips `template-only`/`profile:<name>` Markdown and YAML blocks from
  `MARKER_TARGETS`, keeping only the block for the selected profile.
- Rewrites `package.json` (name, version, description, license, author, repository,
  `bugs`, `homepage`, conditionally keeps `bin` for a CLI or removes it otherwise, drops
  the `bootstrap:e2e` script entry, sets `sideEffects: false`, and profile-conditionally
  sets/removes `engines` using the selected `--node-engines` floor), removes
  `src/cli.ts` when the CLI option is `no`, rewrites `tsconfig.build.json`'s
  `compilerOptions.types` for the profile, rewrites the generated CI package-floor job
  to that same floor, and regenerates `LICENSE` and a bare `CHANGELOG.md`.

`scripts/verify-bootstrap.mjs`, run as `pnpm bootstrap:e2e`, is the flow's own
integration test: `main()` builds a throwaway workspace with `copyTemplate()` (see
below), runs a real `scripts/bootstrap.mjs` subprocess for `node-library` with and
without its CLI and for `universal-library` without one, and calls `assertGenerated()`
against each result — placeholders gone, no bootstrap marker left in `MARKER_TARGETS`,
the legacy release directory absent, `scripts/bootstrap.mjs` itself gone, a bare
changelog, and the expected `package.json` shape (name, `0.0.0`, the requested CLI `bin`
shape, the selected `engines.node` floor and matching package-floor CI leg, and
`sideEffects: false`).

## Profiles

A profile is one of the two entries in `bootstrap.mjs`'s `PROFILES` set (`node-library`,
`universal-library`); `DEFAULT_PROFILE` picks the one the interactive prompt defaults
to. The `--cli` option is a separate yes/no axis, defaulting to `no`: `node-library` may
keep `src/cli.ts` and `package.json#bin`, while `universal-library --cli yes` is
rejected at argument-parsing time. `--node-engines` is a bare `>=N` range, defaulting to
`>=24`; it controls the published `engines.node` and package-floor CI job, while the
development runtime remains Node 24. A profile changes three things, and only these
three: which `<!-- profile:<name>:start -->...<!-- profile:<name>:end -->` Markdown/YAML
blocks survive in `MARKER_TARGETS`, `tsconfig.build.json`'s `compilerOptions.types`
(and, downstream, whether `node:` builtins are allowed in the generated `src/**` — see
`writing-typescript`'s "Runtime-agnostic source"), and whether `package.json#engines` is
present. For `node-library`, the range itself comes from `--node-engines`.

Adding or renaming a profile means: adding it to `PROFILES`, writing its
`profile:<name>` blocks in every Markdown/YAML file that needs to differ by profile,
extending the `tsconfig.build.json`/`package.json` branches in `transform()`, and adding
the profile to `verify-bootstrap.mjs`'s `cases` array so `bootstrap:e2e` actually
exercises it — a profile with no e2e case is untested by definition.

## The self-removal property

A real bootstrap run deletes `scripts/bootstrap.mjs`, `scripts/verify-bootstrap.mjs`,
and both of their test files from the generated repository. That means the **generated
tree** — not this checkout — is the thing a bootstrap change is really tested against; a
check that only ever runs against this checkout can never see what it looks like once
those four files are gone.

That is why both `tests/bootstrap.test.ts` and `scripts/verify-bootstrap.mjs` build
their fixture from `git ls-files` (`copyTemplate` in `scripts/verify-bootstrap.mjs`,
reused by `tests/bootstrap.test.ts` as `copyTrackedFiles`) rather than copying the
working directory: it reproduces exactly the tracked, committed tree a real fork clones,
with none of a developer's local, gitignored build output (`dist/`, `docs/api`,
`coverage/`, ...) mixed in.

That gap is also the trap: a check that consults the real filesystem can render a
different verdict against a built checkout (where `dist/` or `docs/api` exist) than
against a freshly generated tree (where they don't). `namesGeneratedTreeEntry` in
`scripts/bootstrap.mjs` is the rule that closes this for the dangling-reference check
specifically — read its doc comment for the exact three-part shape test and the accepted
residual it documents; this was the actual defect behind issue #106.

This skill itself is part of `SELF_REMOVED_PATHS`, alongside the four files above: a
generated repository has no bootstrap flow left to run or maintain, so a skill
documenting that flow would otherwise survive with nothing left to describe. Removing a
directory entry recursively marks every nested file absent in the dry-run `preview` map
before the real removal runs, so the dangling-reference scan never reads its now-stale
content from disk. AGENTS.md's own Quick reference line and Skills-table row for this
skill are removed the same way, by a small `SELF_REMOVED_AGENTS_LINES` regex list
applied inside `replaceText` — a GFM table row can't be wrapped in the
`<!-- template-only:-->` block markers used elsewhere (an HTML comment or a resulting
blank line both terminate a table early), so the whole line, trailing newline included,
is matched and dropped directly instead.

`scripts/verify-bootstrap.mjs`'s `assertGenerated` closes the loop this is really for:
it re-parses the generated tree's own AGENTS.md Skills table
(`listRoutingTableSkillNames`) and throws `ERR_BOOTSTRAP_STALE_SKILL_ROUTE` if any row
names a skill directory the generated tree does not have — the same invariant
`tests/skills-frontmatter.test.ts` checks in this checkout, checked again in the tree
that actually ships. This is the second time a bootstrap check has been weaker in one
environment than the other (the first was #106's `namesGeneratedTreeEntry`), so a change
that adds a self-removed path or an AGENTS.md line tied to it owes both sides: the
removal itself, and, if it changes what AGENTS.md's Skills table can say, this check.

## The dangling-reference check

`assertGeneratedAiLayer` (called from `bootstrap()`, raising `ERR_AI_LAYER_REFERENCE`)
scans every Markdown file in the generated tree for a backticked, repo-relative path
token and fails if that token names neither a real entry in the generated tree nor an
entry in `DANGLING_REFERENCE_EXEMPTIONS`. It exists to catch a Markdown reference to a
file bootstrap itself just removed, or to a profile-only path left dangling for the
profile that dropped it.

A change to the template's own Markdown (AGENTS.md, README.md, a skill, ...) that adds a
backticked path owes this check one of two things: the path must resolve in every
generated tree the change is meant to apply to, or, if it legitimately never exists in a
generated tree (gitignored build output, a documented-but-unshipped pattern), it belongs
in `DANGLING_REFERENCE_EXEMPTIONS` — read that constant's own comment before adding to
it, since each existing entry documents why it's there.

## How to verify a bootstrap change

Reach for `pnpm exec vitest run tests/bootstrap.test.ts` first — it exercises
`bootstrap()`, `parseArguments`, `findPlaceholders`, and the dangling-reference check
directly, against fixtures built the same `git ls-files` way described above, without
paying for a real subprocess run.

`pnpm bootstrap:e2e` is the one that matters whenever the change could only show up in a
real, end-to-end run: a change to `copyTemplate`/`assertCopyable`'s file-copying
behavior, anything that could make the CLI's interactive or non-interactive argument
path diverge from what the unit tests inject directly, or as a final check before
believing a profile or removal-list change is actually safe for both profiles. It is
slower — it runs `scripts/bootstrap.mjs` as a real subprocess against a real temporary
workspace for both the default Node 24 case and a lower `>=20` package floor — which is
why it isn't the first thing to reach for.
