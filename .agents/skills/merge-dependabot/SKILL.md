---
name: merge-dependabot
description: >
  Triage, verify, and land open Dependabot/Renovate dependency PRs. Surveys all bot PRs,
  classifies bump risk, checks CI and security signals, then either merges eligible PRs
  individually or builds one combined integration PR (regenerating pnpm-lock.yaml) and
  closes the superseded originals once CI is green. Use when landing open Dependabot or
  Renovate pull requests, clearing a backlog of bump PRs, or several dependency PRs
  contest the same lockfile.
---

# Dependabot PR Integration

**Owns:** landing already-open Dependabot/Renovate PRs — triage, landing mode, the
combined branch, and cleanup. **Does not own:** whether a package may be added or bumped
at all, the release-age cooldown, and the supply-chain settings
(`managing-dependencies`); the release-impact note a consumer-visible bump owes
(`release-impact`).

Branch names, commit messages, and PR text follow AGENTS.md's English-only convention.

## Operating Contract

- **Input:** none required. Optionally a subset of PR numbers to restrict scope.
- **Output:** merged PRs and/or one combined PR, plus a written report of what was
  merged, held, or closed.
- **Approval:** one confirmation gate. Do the entire triage first, present the plan, get
  approval **once**, then execute the rest unattended. Never ask per merge; never merge
  before that single approval.
- **Merge policy:** green CI is the bar. Major bumps are **not** auto-held, but they
  MUST be called out explicitly in the plan so the approval is informed.

## Step 1: Survey

```bash
node .agents/skills/merge-dependabot/scripts/survey-prs.mjs
```

The script is read-only. It lists every open bot PR with its ecosystem, semver level,
check rollup, mergeability, touched files, and — importantly — which files are contested
by more than one PR.

Add `--json` when you need to compute over the rows rather than read them.

If it reports no open bot PRs, say so and stop.

## Step 2: Classify each PR

For every row, record:

| Field        | Source                                                         |
| ------------ | -------------------------------------------------------------- |
| semver level | script (`level`)                                               |
| CI state     | script (`checks`, `failingChecks`)                             |
| merge state  | script (`mergeState`) — `CLEAN`, `UNSTABLE`, `BEHIND`, `DIRTY` |
| blast radius | script (`files`)                                               |

Note that `.github/dependabot.yml` groups minor and patch bumps into a single PR per
ecosystem, so one row often carries several dependencies. Majors are deliberately
ungrouped and arrive one per PR. Read the diff of a grouped PR in full — the row's
`level` is only as precise as the title.

Then read the actual diff for anything not purely mechanical:

```bash
gh pr diff <number>
```

**Security review** (do not skip — this is the point of the gate). Run the full
checklist in
[references/failure-modes.md](references/failure-modes.md#security-review-checklist)
against every PR before approving it — GitHub Actions SHA-pinning, release notes for a
major bump, treating a `0.x` minor as a major, the `Dependency Review` check, and never
letting a bump relax a supply-chain setting.

If CI is failing, diagnose before deciding — see
[references/failure-modes.md](references/failure-modes.md). In this repo the most common
failure is **not** a real regression; it is a peer-range conflict or a lockfile that no
longer matches the manifest.

## Step 3: Choose the landing mode

Decide by risk, and state the reasoning in the plan.

**Merge individually** when all hold:

- 3 or fewer eligible PRs, and
- no contested files between them, and
- each is `CLEAN` with `PASSING` checks.

Note that every npm PR touches `package.json` and `pnpm-lock.yaml`, so two open npm PRs
are contested by definition. In practice, individual merges are for GitHub Actions PRs;
npm PRs almost always go through the combined path.

**Build a combined PR** when any holds:

- more than 3 eligible PRs (avoids N sequential rebase-and-wait cycles), or
- two or more PRs touch the same file (the survey prints these), or
- one or more npm PRs need a lockfile regeneration (they cannot go in as-is).

Mixed outcomes are fine: merge the clean Actions PRs directly and combine the npm ones,
for example. Say which PRs go which way.

## Step 4a: Individual merges

Process in ascending PR number, one at a time. After each merge the remaining PRs become
`BEHIND`; rebase the next one and wait for its checks before merging it. Never merge a
PR whose checks you have not re-confirmed **after** its last rebase.

```bash
gh pr checks <number>          # re-confirm green immediately before merging
gh pr merge <number> --squash --delete-branch
gh pr comment <next-number> --body "@dependabot rebase"
```

## Step 4b: Combined PR

Branch, then merge each participating branch in, taking **the higher version** of each
dependency on conflict unless the release notes say otherwise:

```bash
git switch main && git pull --ff-only
git switch -c deps/batch-<yyyymmdd>
git fetch origin <branch>
git merge --no-ff origin/<branch> -m "deps: merge #<number> <title>"
```

Resolve `pnpm-lock.yaml` conflicts by regenerating, never by hand
(`managing-dependencies` owns that rule):

```bash
pnpm install --lockfile-only
git add package.json pnpm-lock.yaml && git commit -m "deps: regenerate the lockfile"
```

Verify locally on the development Node, then on the minimum supported Node (a separate
CI job):

```bash
pnpm install --frozen-lockfile && pnpm check
pnpm --config.runtime-on-fail=ignore run check
```

`pnpm check` also covers the packaging gates (`publint`, are-the-types-wrong, the
tarball smoke test) that a bump can break without touching source. Fix a mechanical
failure (a renamed lint rule, a new type error from a stricter TypeScript) on the
branch; for a judgement call, stop and report instead of merging around it or
suppressing the error.

Push and open the PR with a valid Conventional Commits title (the `check-pr-title`
workflow skips PRs labeled `dependencies`, but the squashed history and generated
release notes still want one). Fill `.github/PULL_REQUEST_TEMPLATE.md` — list every
rolled-up PR as `- #<number> <title>` and put the local verification commands in Test
Plan:

```bash
git push -u origin HEAD
gh pr create --title "deps: batch dependency updates" \
  --label dependencies --body "<filled PR template>"
```

A dependency bump that consumers can observe (a changed peer range, a raised
`engines.node`, a new runtime dependency) needs a release-impact note
(`release-impact`); a devDependency bump does not.

## Step 5: Land and clean up

Wait for CI, merge only on green, then close every superseded original with a pointer —
but only **after** the combined PR is merged. If it is abandoned instead, leave the
originals open.

```bash
gh pr checks <combined-number> --watch
gh pr merge <combined-number> --squash --delete-branch
gh pr close <number> --comment "Superseded by #<combined-number>." --delete-branch
```

## Step 6: Report

State plainly:

- merged (with PR numbers and what landed)
- held, and the specific reason
- closed as superseded
- any CI failure you saw, with the real error, not a summary of it

If something failed, say so with the output. Do not describe a partially completed run
as done.

## Critical Rules

- **One approval gate only** — after Step 3's plan is approved, run to completion.
- **Never** merge on `PENDING` checks; re-confirm green after every rebase.
- **Never** hand-edit `pnpm-lock.yaml` (`managing-dependencies` owns this rule); run
  `pnpm install --lockfile-only` instead.
- **Never** close an original PR before its replacement is merged.
- **Never** unpin a SHA-pinned GitHub Action to make a bump apply cleanly.
- **Never** use `--admin`, `--no-verify`, or force-push, and never weaken a gate to land
  a bump — AGENTS.md's "Security and human approval" applies here unchanged.
- **Stay in scope** — this skill lands dependency bumps. Unrelated cleanups you notice
  go in the report as suggestions, not in the branch.
