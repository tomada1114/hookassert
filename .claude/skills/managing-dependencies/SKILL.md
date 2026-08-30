---
name: managing-dependencies
description: >
  Covers whether a package may be added to this repository at all and what happens to it
  at install time: the review record a PR adding a runtime dependency must carry, SemVer
  range versus exact pin, the minimumReleaseAge cooldown and its exception process, the
  supply-chain settings in pnpm-workspace.yaml, and the typescript version ceiling. Use
  when adding or bumping a dependency, editing package.json's dependencies, an install
  fails on a peer range or the cooldown, or someone proposes raising typescript.
---

# Managing Dependencies

**Owns:** whether a package may exist in this repository at all, and what happens at
install time. **Does not own:** landing an existing bot PR (`merge-dependabot`); the
semver consequence of a bump for this package's own published version
(`release-impact`).

## The review record a new runtime dependency needs

Adding a runtime dependency is a permanent supply-chain commitment, so before adding
one, record all of the following in the PR that adds it. Missing one item is not a
detail to fill in later — it means the review has not actually happened yet.

- Why a small hand-written helper or a Node builtin cannot replace it. For a package
  with a `bin`, check `node:util`'s `parseArgs` first: it covers subcommands
  (`allowPositionals`) and rejects unknown flags (`strict`), so an argument-parser
  dependency needs a reason beyond convenience.
- Maintainer and release continuity — actively maintained, not abandoned.
- License compatibility (MIT/BSD/Apache-class; a copyleft license needs a deliberate,
  explicit reason for a published library).
- Direct and transitive package count it pulls in — a large transitive surface is a real
  cost even behind a small direct API.
- Whether it runs an install script, ships a native binary, or does network access —
  each needs its own justification, and an install script also needs an `allowBuilds`
  entry (see below).
- Unpacked size and its effect on this package's own published tarball.
- Supported Node versions and module format (ESM/CJS) against this package's own
  `engines`/`exports` in `package.json`.
- Open security advisories and npm provenance.
- Which of `dependencies`, `devDependencies`, `peerDependencies`, or
  `optionalDependencies` it belongs in, and why.

## The first runtime dependency in a generated repository

The repository's packaging tests cover a declared dependency separately from a bundled
installed-dependency directory, and the consumer smoke suite may mock npm at its
subprocess boundary for fast branch coverage. That mock does not prove that a package
manager can resolve the dependency, or that this repository's cooldown, trust, and
lifecycle rules permit it.

When a generated repository adds its first runtime dependency, land the manifest and
lockfile change only after running `pnpm package:check` and `pnpm package:smoke` for
real. Those commands exercise the packed manifest and an actual throwaway consumer
install; keep the dependency declared in `dependencies`, never bundle it into the
tarball, and do not treat the mocked unit/automation case as a substitute for either
real command.

## What a `peerDependencies` entry actually does here

No gate asserts that a declared peer range is satisfiable. What the two package managers
do with one differs, which is worth knowing before you rely on either:

- `pnpm install` auto-installs an unsatisfied peer of this package as an ordinary
  dependency, picking the **highest** version matching the range. A `devDependencies`
  entry naming the same package wins instead, and pnpm does not complain when that entry
  falls outside the declared peer range.
- The consumer smoke test (`scripts/smoke-package.mjs`) installs the tarball with
  `npm install --legacy-peer-deps`, so the throwaway consumer never fetches a peer from
  the network and `node_modules` holds only the package under test. That is what proves
  the more useful thing: the published package installs and its `bin` runs _before_ the
  consumer has the peer in place, which is the real first-run experience of
  `npx <tool>`. A `bin` that actually needs the peer at runtime must therefore fail with
  its own diagnostic, not a bare module-resolution stack trace.
- Whether the declared range itself is satisfiable by anything on the registry is not
  tested here — asserting that needs the real network by definition, so it belongs in a
  separate CI job, not in the offline smoke test.

## Testing against a version the ceiling forbids

The TypeScript ceiling below is a real ceiling: `typescript@7` as a `devDependencies`
entry fails the install outright under `strictPeerDependencies`. The same holds for any
peer runtime this repository's own toolchain caps.

A package whose product must _support_ such a version does not raise the ceiling for it.
It installs that version into a fixture project under `tests/fixtures/` and drives it as
a child process, keeping the version under test out of this repository's own dependency
graph entirely.

## Range vs. pin, and how a change lands

- A runtime dependency declares a SemVer **range**, never an exact pin — the library
  does not own reproducibility here, `pnpm-lock.yaml` does.
- Add or bump through `pnpm add`, never by hand-writing a version into `package.json`. A
  hand-typed recent version can be younger than the cooldown below, and a pin has no
  older version to fall back to, so the install fails outright rather than resolving to
  something older.
- A dependency change and its `pnpm-lock.yaml` update belong in the same commit. The
  lockfile is generated, never hand-edited.
- Dev dependencies are kept current by bot PRs plus the lockfile, not by hand.
  **REQUIRED:** `merge-dependabot` to land one.

## The release-age cooldown

`pnpm-workspace.yaml` sets a `minimumReleaseAge` cooldown: a version published too
recently will not resolve, for any install. Treat this as behavior to design around, not
an obstacle to route past.

- A `^`/`~` range silently resolves to an older, already-cooled version instead of the
  newest matching one — this is expected, not a bug.
- An exact pin on a version younger than the cooldown fails the install outright, since
  there is no older matching version for a pin to fall back to.
- Before adding or bumping a dependency, check how long its target version has actually
  been published; do not assume `latest` will resolve.

### Exception process

For an urgent security fix younger than the cooldown, a human may approve an exact
`package@version` entry in `minimumReleaseAgeExclude`. The same PR must:

- cite the advisory,
- explain why waiting is riskier than skipping the cooldown,
- include the regenerated lockfile, and
- state when the exception will be removed.

Never add a wildcard entry or a package-only (unversioned) exclusion — the exception is
scoped to one exact version, not to the package forever.

## Supply-chain settings, as consequences

`pnpm-workspace.yaml` holds the values; this is what each one means when it fires. Read
the file for the current values rather than trusting a number copied here.

- `strictDepBuilds` plus `allowBuilds`: an install-time lifecycle script from a
  dependency that is not allowlisted fails the install **on purpose** — that is the
  intended outcome, not a bug to route around. `lefthook` is the one currently
  allowlisted entry, a reviewed exception because its postinstall is how its Git-hook
  binary is downloaded and linked. Adding another entry carries the same review weight
  as adding a new dependency.
- `strictPeerDependencies`: a peer range declared by an installed **dependency** and
  left unmet or conflicting is a hard install failure, not a warning. This is what makes
  the TypeScript ceiling below an enforced constraint instead of an advisory one. It
  says nothing about a peer this package declares for its own consumers — see "What a
  `peerDependencies` entry actually does here" above for that.
- `minimumReleaseAgeStrict` and `minimumReleaseAgeIgnoreMissingTime` close two specific
  bypasses of the cooldown above: an already-lockfiled version skipping the check, and
  registry metadata with no publish time being treated as old enough, respectively.
- `trustPolicy`, `trustLockfile`, and `blockExoticSubdeps` are independent supply-chain
  protections, not part of the cooldown: they reject a provenance/trusted-publisher
  regression, refuse to trust the trust metadata recorded in a contributor's lockfile,
  and refuse transitive dependencies fetched from git or arbitrary tarball URLs,
  respectively.

When one of these fires, find out why the install is actually failing; AGENTS.md holds
the prohibition on relaxing it.

- `verifyDepsBeforeRun: error`: a `pnpm run` whose `node_modules` no longer matches the
  lockfile fails instead of letting a gate pass against stale dependencies. The fix is
  `pnpm install`, never a weaker value. pnpm compares dependency fields and the settings
  above, so an unrelated manifest rewrite — the minimum-Node CI leg's
  `git restore package.json` — only costs a deeper check, not a failure.

## TypeScript version ceiling

`typescript` is held below the version that `typescript-eslint` and `typedoc` cap their
peer support at (see `package.json`'s `devDependencies` for the current range). With
`strictPeerDependencies` on, a bump past that ceiling fails the install rather than
merely warning.

Do not "upgrade typescript to latest." Raising this ceiling is a coordinated
multi-package upgrade — `typescript-eslint` and `typedoc` both need to raise their own
peer ranges first — not a routine dependency bump.

## Handoff

**REQUIRED:** `merge-dependabot` for landing an already-open bot PR against these rules.
