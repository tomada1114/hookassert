---
name: writing-repo-scripts
description: >
  Use when writing or editing a .mjs under scripts/** or scripts/lib/**, or when
  repository automation misbehaves under a git hook: an inherited GIT_DIR or
  GIT_INDEX_FILE making a spawned git write to the wrong repository despite a cwd or -C
  (isolatedGitEnv), a lefthook pre-commit failure, importing anything outside node:*
  builtins, JSDoc boundary types under allowJs/checkJs, narrowing JSON.parse through
  scripts/lib/json.mjs, the isMain(import.meta.url) CLI guard, or how a script must
  report failure on stderr with an ERR_<STAGE>_* code.
---

# Writing Repository Scripts

**Owns:** the authoring contract for `scripts/**/*.mjs` — imports, typing, git safety,
and the stderr contract. **Does not own:** authoring a skill or mirroring it into
`.claude/skills/` (`authoring-skills`); where a script's tests live and its coverage
floor (`placing-tests`); the `ERR_<STAGE>_*` code vocabulary shared with `src/`
(`designing-errors`).

## Why `.mjs`, not `.ts`

- `scripts/**` must run on a plain Node **before** `pnpm install` has been run, so it
  cannot depend on a compile step or on anything installed. Author it as `.mjs`.
- Import only `node:*` builtins and the shared helpers under `scripts/lib/`. Never
  import a dependency from `node_modules` directly — a script that needs an installed
  tool resolves it at run time through `resolveDependencyBin`
  (`scripts/lib/node-tools.mjs`) instead, so the script still loads even when that
  dependency is absent.
- Import Node globals explicitly (`import process from "node:process"`,
  `import console from "node:console"`) rather than relying on the ambient globals Node
  provides at the top level.

## Typing under `allowJs`/`checkJs`

Enforced by: `tsconfig.json`'s `allowJs`/`checkJs` and the `scripts` include entry; the
automation/node-scripts block in `eslint.config.mjs`.

- These files are type-checked exactly like a `.ts` module. Declare boundary types in
  JSDoc (`@param`, `@returns`, `@typedef`) with the same rigor as a TypeScript signature
  — an untyped parameter here is as much a gap as one in `src/`.
- Receive `JSON.parse` output as `unknown` and narrow it through `readKey`/`readString`
  in `scripts/lib/json.mjs`, never a direct cast. `noPropertyAccessFromIndexSignature`
  and the typed-lint `dot-notation` rule disagree about literal-key access on a
  `Record`, so reads go through these helpers instead of picking one style and tripping
  the other.

```js
import { parseJson, readString } from "./lib/json.mjs";

const manifest = parseJson(readFileSync(manifestPath, "utf8"));
const name = readString(manifest, "name");
```

## The CLI guard

A file that is both importable (from a test) and runnable as a command guards its CLI
half with `isMain(import.meta.url)` from `scripts/lib/is-main.mjs`, so importing it for
a test never triggers a run.

```js
import { isMain } from "./lib/is-main.mjs";

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
```

Note that the helper predates the current Node floor (see package.json's engines);
`import.meta.main` now covers the same ground, so `isMain` is a candidate for removal
rather than a pattern to defend indefinitely — do not build new indirection on top of
it.

## Spawning `git`

Git exports `GIT_DIR` to every hook it runs, and `git commit -- <path>` also exports a
temporary `GIT_INDEX_FILE`; `lefthook.yml` runs this suite from its own pre-commit hook.
An inherited `GIT_DIR` **outranks** both a `cwd` and an explicit `-C` — a `git` spawned
with only a `cwd` writes to the outer repository's index and object store, not the one
the caller meant.

Any `git` invocation that names the repository it means must clear `GIT_*` first, with
`isolatedGitEnv` from `scripts/lib/git-env.mjs`:

```js
import { isolatedGitEnv } from "./lib/git-env.mjs";

spawnSync("git", ["init", "-q"], { cwd: fixtureDir, env: isolatedGitEnv() });
```

The one exception is `scripts/check-staged.mjs`, which **is** the pre-commit layer and
must read the index that hook was given, so it inherits `GIT_*` deliberately. Its own
tests clear the variables from their own process with `vi.stubEnv` instead of routing
through `isolatedGitEnv`.

## The stderr contract

An error raised by automation is read by an agent, not a human watching a terminal, so
it must say: what failed, the path or export involved, expected versus actual, an error
code, and the next safe command to run — and never a secret or an absolute home path.
**REQUIRED:** `designing-errors` for the `ERR_<STAGE>_*` code vocabulary a new script's
errors should join.

Worked example, from `scripts/lib/node-tools.mjs`:

```
ERR_DEPENDENCY_MISSING: eslint is not installed.
Expected: node_modules/eslint/package.json
Next: run `pnpm install --frozen-lockfile`.
```

## Coverage

A new script is covered by the `scripts/**` coverage floor from the moment it exists —
an untested file counts as 0%, not as absent from the measurement. **BACKGROUND:**
`placing-tests` explains why `scripts/**` and `scripts/lib/guard/**` carry their own
floors instead of `src/**`'s.
