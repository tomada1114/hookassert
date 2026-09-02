---
name: public-api-contract
description: >
  Covers what may be published from src/index.ts, how src/internal/ stays private, and
  how package.json's exports/files allowlists and the @public TSDoc tag declare the
  surface. Use when adding or removing an export in src/index.ts, deciding whether a
  symbol belongs in src/internal/, editing package.json's exports or files fields, or
  running pnpm package:check / pnpm package:smoke.
---

# Public API Contract

**Owns:** what the published surface may contain and how it is declared. **Does not
own:** the same-PR checklist and the semver decision (`release-impact`), the type-system
judgment, naming, and constant placement inside a module (`writing-typescript`), or how
the surface is tested (`writing-tests`, `type-testing`).

## Layout

AGENTS.md's Architecture section carries the `src/` tree — `src/index.ts`,
`src/internal/`, and the `*.ts` modules it re-exports. What follows is what each part of
that tree may publish, not the tree itself.

## `src/index.ts` is the entire contract

- `src/index.ts` is the single entry point of the public contract. Every public symbol
  is re-exported from it **by name**. There is no default export and no `export *`, so
  the published surface is always something you can read in one file, top to bottom.
  Enforced by: `eslint.config.mjs`'s `no-restricted-syntax` (blocks
  `ExportAllDeclaration`) and `no-restricted-exports` (blocks default exports).
- Adding a line to `src/index.ts` makes that symbol public API. Decide that deliberately
  at the moment you write the line — this is the decision point, not something to catch
  later at review time.
- Removing a line is equally a break: a consumer's import stops resolving. Treat a
  removal with the same weight as an addition.

`src/cli.ts` is an optional command entry, not a second import surface. A package may
name its emitted `dist/cli.js` through `package.json#bin`; that command is exercised
through its `argv`/exit/output behavior rather than re-exported from `src/index.ts`.
Keeping command code out of the import surface avoids turning a runnable entry into
public API by accident.

## `src/internal/` is private

- `src/internal/` is private regardless of what a file inside it is named — the
  directory, not the name, is what makes it private. Exporting one of its symbols from
  `index.ts` publishes it. Enforced by the public-api/internal-stays-private block in
  `eslint.config.mjs`, a `src/index.ts`-scoped `no-restricted-syntax` rule.
- Nothing outside `src/**` may import from `src/internal/` directly, except `tests/**`,
  which may import a module's `index.ts` — a test is not a consumer. Repository
  automation is: `scripts/**/*.mjs` reaches the package only through what `src/index.ts`
  re-exports. Enforced by two `no-restricted-imports` blocks in `eslint.config.mjs` —
  boundaries/internal-is-not-importable over `scripts/**/*.mjs` (unconditional) and
  boundaries/tests-reach-internal-through-its-index over `tests/**/*.ts` (index-only).
  Both cover the built copy under dist as well as the source — the same private module
  either way, and a test never reads build output.

## `package.json` allowlists

- `exports` and `files` in `package.json` are allowlists, not documentation of intent. A
  path not listed in either is private, and a deep import into `dist/` — reaching past
  the allowlist into an internal module — is expected to fail for a consumer even if the
  file exists on disk.
- A new subpath export (a second entry under `exports`, a deep export) is a
  public-surface decision with the same weight as a new symbol in `index.ts` — it is not
  a packaging detail to slip in separately.

## Declaring intent on each symbol

- Every public declaration carries a TSDoc release tag, `@public`. No build step fails
  over a missing one — it is a convention for readers, so a symbol reachable from
  `index.ts` says out loud that it is part of the contract rather than something
  re-exported by accident.
- A public symbol with no TSDoc at all does fail the build. Enforced by:
  `typedoc.json`'s `validation.notDocumented`, which runs against `src/index.ts` as the
  sole entry point — `src/internal/` and test-only code never enter this check.
- A public symbol whose type references something unexported leaves a consumer unable to
  name that type in their own code. Enforced by: `typedoc.json`'s
  `validation.notExported`.

## Verifying the surface as a consumer sees it

- `pnpm package:check` builds, packs, and runs every artifact check (`publint`, Are the
  Types Wrong?, and the consumer smoke test) against the packed tarball rather than the
  source tree.
- `pnpm package:smoke` runs just the consumer-install leg — the same
  `scripts/smoke-package.mjs` that `package:check` and `pnpm check` already invoke
  through `scripts/verify-package.mjs` — so reach for it for a fast focused iteration on
  an `exports`/`files` problem, not as an extra pass after a green `pnpm check`.
- Both read the tarball's own packed manifest, not the repository's `package.json` in
  place, so a stale `files` entry surfaces here even when every other gate is green.

**REQUIRED:** `release-impact` for what a change to this surface obliges the same pull
request to carry.
