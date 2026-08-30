---
name: writing-typescript
description: >
  Use when writing or reviewing a module under src/**/*.ts: narrowing unknown instead of
  any, `satisfies` vs `as`, a type guard, interface vs type, an exhaustive switch over a
  union, `import type` under verbatimModuleSyntax, why `enum` (erasableSyntaxOnly) and
  `node:` imports are rejected in src/, annotating a return type or a generic boundary,
  hitting noUncheckedIndexedAccess, exactOptionalPropertyTypes or
  noPropertyAccessFromIndexSignature, placing a new constant, or fixing a logic bug in
  an existing src/ function.
---

# Writing TypeScript

**Owns:** type-system judgment, naming, and constant placement inside a `src/**/*.ts`
module. **Does not own:** the shape of an error class (`designing-errors`); what may be
exported from `src/index.ts` (`public-api-contract`); the `.mjs` files under `scripts/`
(`writing-repo-scripts`).

## Naming and constants

- An error `code` string is not a naming decision made here — **REQUIRED:**
  `designing-errors` owns the `ERR_*` vocabulary for both `src/` and `scripts/`.
- Keep a constant next to the code that uses it. Do not create a shared `constants.ts`
  grab-bag that forces unrelated modules to import each other.

## Boundary types: unknown, any, and assertions

- Take `unknown` at an untyped boundary (parsed JSON, a caught error, a third-party
  callback) and narrow it before use; `any` disables checking for everything downstream
  of it, not just at the boundary.
- Prefer `satisfies` to `as` on a typed literal: `satisfies` keeps excess-property and
  missing-property checking, `as` silences both.
- A type assertion (`as T`) changes only the compile-time type — it provides zero
  runtime safety. Reach for a type guard (`value is T`) when narrowing based on runtime
  shape, and keep any assertion that survives review local and non-exported.

## Imports

- Mark a type-only named import inline (`import { value, type X } from "./x"`), the form
  `@typescript-eslint/consistent-type-imports` autofixes to, per `eslint.config.mjs`'s
  `fixStyle` setting for that rule. A separate `import type { X } from "./x"` statement
  also satisfies the rule and is fine when every named import in the statement is
  type-only.
- Never hand-fix an import differently from what `pnpm fix` produces.

## interface vs type

- Prefer `interface X extends Y` to `type X = Y & Z` when composing object types — the
  `&` operator is markedly slower to type-check, and the gap widens with the number of
  intersected members.
- `@typescript-eslint/consistent-type-definitions` already prefers `interface` for
  object shapes; this is the reason behind that rule, not an extra rule of its own.

## Strictness flags to work with, not around

- Indexed access (`arr[i]`, `record[key]`) yields `T | undefined` here —
  `noUncheckedIndexedAccess` is on. Treat the `undefined` branch as real rather than
  asserting it away.
- `exactOptionalPropertyTypes` makes an absent property and an explicit `undefined`
  distinct types. A public `XOptions` interface declares its properties `readonly` and
  `?:` (mirroring `NormalizeIdentifierOptions` and `WithTimeoutOptions`); an internal
  argument whose omission would be a bug takes a required `T | undefined` instead, so a
  caller cannot drop it by accident.
- `noPropertyAccessFromIndexSignature` forbids dot access on an index signature, while
  typed-lint's `dot-notation` pushes the other way for a literal key. A literal
  `as const` object escapes the conflict because its keys are literal, not an index
  signature; a widened `Record<string, T>` does not. `scripts/lib/json.mjs`'s
  `readKey`/`readString` are the resolution used for parsed-JSON reads — see
  `writing-repo-scripts` for that rule itself.
- Do not introduce `enum`. `tsconfig.json`'s `erasableSyntaxOnly` forbids it.

## Function boundaries and generics

- Annotate the return type of every non-generic export from `src/index.ts`.
- On a generic export, annotate the return type only if the annotation is provably no
  wider than what inference would produce, and cover the exported signature with an
  `expectTypeOf` test in `tests/types.test.ts` either way — a hand-written annotation is
  the standard way to accidentally widen a generic that should stay preserved.
- Keep exported generics narrow: accept the widest reasonable input, return the
  narrowest true output. `withTimeout` is the worked example — it returns the
  operation's own resolved type instead of widening it to something looser.
- Let inference do the work inside a function body; reserve explicit annotations for
  boundaries (parameters, exported return types), not every local binding.

## Discriminated unions and exhaustiveness

- Prefer a discriminated union with a literal field (`code`, `kind`) over a bag of
  optional flags when a value has mutually exclusive shapes, and narrow it by branching
  on that field rather than checking several optional properties together.
- Handle a union exhaustively by giving each member its own `case`. Do not add a
  `default` branch to make the check pass:
  `@typescript-eslint/switch-exhaustiveness-check` in `eslint.config.mjs` sets
  `considerDefaultExhaustiveForUnions`, so a `default` is read as the deliberate answer
  to a new union member, not a placeholder — adding one to silence the rule is what
  disables the protection it exists to give.

## Runtime-agnostic source

- Whether `node:*` imports are allowed in `src/**` depends on the profile this
  repository was bootstrapped with. Read `tsconfig.build.json`'s
  `compilerOptions.types`: `["node"]` is the `node-library` profile and `node:` builtins
  are permitted; `[]` is the `universal-library` profile, where `eslint.config.mjs`
  registers the universal-profile/no-node-builtins block and a `node:` import is an
  error — move Node-only code behind a separate conditional export entry instead.
