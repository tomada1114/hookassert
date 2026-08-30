---
name: authoring-skills
description: >
  Covers how a skill in this repository is authored under .agents/skills/, mirrored into
  .claude/skills/ by scripts/sync-agents.mjs, and validated so a malformed SKILL.md does
  not silently fail to load. Use when adding, editing, or reviewing a SKILL.md, running
  pnpm agents:sync or pnpm agents:check, deciding whether new material belongs in
  AGENTS.md or a new skill, or investigating why a skill never fires in Claude Code or
  Codex CLI.
---

# Authoring Skills

**Owns:** how a skill in this repository is authored, mirrored, and kept from silently
failing to load. **Does not own:** the general `scripts/**` import and typing contract
(`writing-repo-scripts`); the content of any individual skill.

## The single source of truth

- Author every skill once, under `.agents/skills/<name>/` — the path Codex CLI discovers
  project skills from. `scripts/sync-agents.mjs` mirrors that tree into
  `.claude/skills/`, the only path Claude Code reads.
- Both copies are real, committed files. A symlink would work from this checkout but not
  from a fresh clone on every platform, and Codex follows a linked directory into its
  own subdirectories, registering a nested SKILL.md as a second, nameless skill.
- Loop: edit the `.agents/` copy, run `pnpm agents:sync`, commit both sides. Never
  hand-edit anything under `.claude/skills/` — the next sync overwrites it silently, and
  a hand edit there drifts from the source it should mirror.
- Drift between the two trees fails `pnpm agents:check`, `tests/sync-agents.test.ts`,
  and lefthook's pre-commit hook — all three compare the trees byte for byte, not just
  spot-check `name`.

## Layout

- Exactly one directory level under `.agents/skills/`: `.agents/skills/<name>/SKILL.md`
  plus optional reference, script, or asset subdirectories beneath that same skill
  directory. No category subfolders — `tsconfig.json`'s exclude glob and the mirror both
  assume one path segment between the skills root and the skill's own files.
- No file below a skill root may itself be named `SKILL.md`. A nested one registers as a
  second, nameless skill in both hosts. Name reference files for their content instead
  (`failure-modes.md`, not another `SKILL.md`).
- No symlinks anywhere under either tree — `scripts/sync-agents.mjs` rejects any entry
  that is not a plain file or directory.

## Frontmatter

Exactly two keys, `name` and `description`. Do not add any third key — no `paths`, no
`globs`, no host-specific extension. Claude Code's own `paths` field would gate
auto-invocation on a glob, but Codex CLI has no such field: it ignores an unknown key
and matches only on `description`. The same skill would then auto-fire on different
terms per host, so a portable skill keeps `description` as its one trigger surface. A
key outside `name`/`description` also fails `tests/skills-frontmatter.test.ts`'s two-key
check.

- `name` is byte-identical to the directory name.
- English only, per AGENTS.md's Conventions. Enforced by:
  `tests/skills-frontmatter.test.ts`.
- The description is a retrieval string describing the situation that should load the
  skill (file globs, command names, error strings, decisions), never a summary of the
  skill's internal workflow. Both hosts select a skill on the description's _meaning_,
  so a trigger keyword mirrored into another language buys nothing.
- The description is length-capped. Enforced by: `tests/skills-frontmatter.test.ts`,
  which owns the limit.

`tests/skills-frontmatter.test.ts` enforces the two-key shape, the `name` match, the
length cap, and the English-only rule; it is the one check that would otherwise have no
gate at all — see "Why this needs its own test" below.

## When a new skill is warranted

Add a skill only for work that recurs and needs a workflow, local references, or policy
loaded on demand — not for a fact stated once. Extend an existing skill instead of
creating a near-duplicate when the new material is a variant of what that skill already
covers.

One home per rule: a rule stated in both AGENTS.md and a skill costs context twice and
the two copies drift apart. The one exception is a prohibition an agent needs even while
its own declared task is something else entirely (for example, never weaken a gate to
make a run pass) — that stays in AGENTS.md, where every agent reads it regardless of
task, and a task-specific skill holds only the reasoning an agent doing that task needs.

Every skill opens with a two-line ownership block (`**Owns:**` / `**Does not own:**`)
naming what it decides and what a named sibling decides. Cross-reference a sibling skill
by name, never by path, using one of two markers and no other: `**REQUIRED:** <skill>`
when the agent must load that skill to finish the task, `**BACKGROUND:** <skill>` when
it only explains why.

Do not write down what a config already enforces. Name the gate in one line
(`Enforced by: <file> "<setting>".`) and spend the skill's words on the judgment the
config cannot express — the same principle AGENTS.md states for itself.

## Size and structure

- Target 150 body lines per `SKILL.md`, never exceed 200.
- A `references/*.md` file stays under 400 lines and is linked with a relative path one
  level deep, never with `@` and never as an absolute path.

## Formatting and spell-check apply to the source, not the mirror

`.agents/skills/**` is neither Prettier-ignored nor excluded from `typos` — unlike
`.claude/skills/`, which is excluded from both because it is generated. Run `pnpm fix`
before committing a new or edited `SKILL.md`. When a technical term the checker flags is
unavoidable, add it to `typos.toml`'s `default.extend-words` rather than working around
the checker.

## Scripts bundled inside a skill

A `.mjs` file shipped under `.agents/skills/<name>/scripts/` is linted and type-checked
through JSDoc exactly like `scripts/**` — imports limited to `node:*` builtins and
`scripts/lib/` helpers, `unknown` narrowed through `readKey`/`readString`, explicit
`node:process`/`node:console` imports. It sits outside `coverage.include`, though, so it
is never counted toward a coverage floor. Keep it a thin dispatcher and put anything
with real branching logic in `scripts/` instead, where the floor actually applies.
**REQUIRED:** the full contract in `writing-repo-scripts`.

## Why this needs its own test

`pnpm agents:check` only proves the two trees are byte-identical; it says nothing about
whether the source tree is well-formed. Prettier and `typos` format and spell-check the
file without parsing its frontmatter. A `SKILL.md` whose frontmatter fails to parse,
whose `name` disagrees with its directory, or whose `description` carries a stray key or
non-English trigger word passes every one of those checks, mirrors cleanly, and simply
never loads in either host — nothing reports it. `tests/skills-frontmatter.test.ts` is
what closes that gap, so before committing a new or changed skill run:

```bash
pnpm agents:check
pnpm test
```
